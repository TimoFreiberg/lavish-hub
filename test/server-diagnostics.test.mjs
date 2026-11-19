import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serve } from '../vendor/lavish/src/server.js';
import { createServerDiagnostics, markServerDiagnostic } from '../vendor/lavish/src/server-diagnostics.js';

test('server diagnostics are opt-in, bounded in content, and trace held and aborted requests', async t => {
  const lines = [];
  let closed;
  const closeObserved = new Promise(resolve => { closed = resolve; });
  const app = express();
  app.use(createServerDiagnostics({ write: line => { lines.push(line); if (JSON.parse(line).event === 'close') closed(); } }));
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  app.use(async (req, res) => {
    markServerDiagnostic(res, 'lookup-start');
    entered();
    await held;
    markServerDiagnostic(res, 'lookup-end');
    res.end('ok');
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { release(); server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  const request = fetch(`${base}/hub-proxy/secret-key/action?query-secret`, { signal: controller.signal, headers: { 'x-secret': 'header-secret' } }).catch(() => {});
  await started;
  assert.deepEqual(lines.map(line => JSON.parse(line).event), ['arrive', 'lookup-start']);
  controller.abort();
  await request;
  await Promise.race([closeObserved, new Promise((_, reject) => setTimeout(() => reject(new Error('close not observed')), 2000))]);
  release();
  const records = lines.map(line => JSON.parse(line));
  assert.equal(records[0].route, 'proxy-action');
  assert.equal(records.at(-1).event, 'close');
  assert.ok(!lines.join('\n').includes('secret'));
});

test('successful requests finish', async t => {
  const lines = [];
  const app = express();
  app.use(createServerDiagnostics({ write: line => lines.push(line) }));
  app.use((_req, res) => res.end('ok'));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/artifact/key/image.png?secret`)).status, 200);
  const records = lines.map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => record.event), ['arrive', 'finish', 'close']);
  assert.ok(records.every(record => record.route === 'artifact-asset'));
  assert.equal(records[1].status, 200);
});

test('real server traces proxy and artifact lookups only when enabled', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lavish-diagnostics-'));
  const file = path.join(dir, 'review.html');
  await writeFile(file, '<!doctype html><title>Review</title>');
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = function (chunk) { lines.push(String(chunk)); return true; };
  t.after(() => { process.stderr.write = original; });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const records = () => lines.flatMap(line => { try { const record = JSON.parse(line); return record.side === 'server' ? [record] : []; } catch { return []; } });
  for (const enabled of [true, false]) {
    const server = await serve({ port: 0, stateFile: path.join(dir, enabled ? 'on.json' : 'off.json'), env: { LAVISH_HUB_DIAGNOSTICS: enabled ? '1' : '0' }, allowedHosts: [], host: '127.0.0.1', detectTailscale: null });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const opened = await post('/api/sessions', { file });
      assert.equal(opened.status, 200);
      const { key } = await opened.json();
      const registration = await post('/api/hub-proxy/register', { key, port: 1234, capability: 'a'.repeat(64), resourceKey: 'b'.repeat(64), identityKey: 'c'.repeat(64) });
      assert.equal(registration.status, 200);
      lines.length = 0;
      const proxy = await fetch(`${base}/hub-proxy/${key}/action`, { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST' } });
      assert.equal(proxy.status, 204);
      const artifact = await fetch(`${base}/artifact/${key}/review.html?private-query`);
      assert.equal(artifact.status, 200);
      await artifact.text();
      const missing = await fetch(`${base}/artifact/0000000000000000/missing.html`);
      assert.equal(missing.status, 404);
      await missing.text();
      const logged = records();
      if (!enabled) { assert.deepEqual(logged, []); continue; }
      const arrivals = logged.filter(record => record.event === 'arrive');
      assert.deepEqual(arrivals.map(record => record.route), ['proxy-action', 'artifact-page', 'artifact-page']);
      assert.equal(new Set(arrivals.map(record => record.id)).size, 3);
      for (const [index, arrival] of arrivals.entries()) {
        const trace = logged.filter(record => record.id === arrival.id);
        assert.deepEqual(trace.map(record => record.event), ['arrive', 'lookup-start', 'lookup-end', 'finish', 'close']);
        assert.equal(trace[3].status, [204, 200, 404][index]);
      }
      assert.ok(!lines.join('\n').includes('private-query'));
    } finally { await server.close(); }
  }
});

test('real server logs arrival before rejecting a host', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lavish-diagnostics-'));
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = function (chunk, ...args) { lines.push(String(chunk)); return true; };
  t.after(() => { process.stderr.write = original; });
  const server = await serve({ port: 0, stateFile: path.join(dir, 'state.json'), env: { LAVISH_HUB_DIAGNOSTICS: '1' }, allowedHosts: [], host: '127.0.0.1', detectTailscale: null });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.port, path: '/artifact/private-key/index.html?private-query', headers: { host: 'private-host.invalid' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
  assert.equal(status, 403);
  const records = lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(record => record?.side === 'server');
  assert.deepEqual(records.map(record => record.event), ['arrive', 'finish', 'close']);
  assert.equal(records[0].route, 'artifact-page');
  assert.ok(!JSON.stringify(records).includes('private'));
});
