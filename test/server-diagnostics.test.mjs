import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serve } from '../vendor/lavish/src/server.js';
import { createServerDiagnostics, markServerDiagnostic } from '../vendor/lavish/src/server-diagnostics.js';

test('server diagnostics are opt-in, bounded in content, and trace held and aborted requests', async t => {
  const lines = [];
  let closed;
  const closeObserved = new Promise(resolve => { closed = resolve; });
  const app = express();
  app.use(createServerDiagnostics({ enabled: true, write: line => { lines.push(line); if (JSON.parse(line).event === 'close') closed(); } }));
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

test('disabled diagnostics do not write and successful requests finish', async t => {
  const lines = [];
  const app = express();
  app.use(createServerDiagnostics({ enabled: false, write: line => lines.push(line) }));
  app.use(createServerDiagnostics({ enabled: true, write: line => lines.push(line) }));
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
