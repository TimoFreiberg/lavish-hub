import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { encode, decode } from '@toon-format/toon';
import { createLavishClient, lavishHttpRun, supportedLavishVersion } from '../src/lavish-http.mjs';

const keyFor = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
async function fixture(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lavish-http-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = path.join(dir, 'state'); await mkdir(state);
  const file = path.join(dir, 'review.html'); await writeFile(file, '<!doctype html><html lang="en"><title>HTTP probe</title><p>Review</p></html>');
  const env = { ...process.env, LAVISH_AXI_TELEMETRY: '0', LAVISH_AXI_STATE_DIR: state };
  const health = { ok: true, app: 'lavish-axi', version: supportedLavishVersion, state_id: keyFor(path.join(await realpath(state), 'state.json')) };
  return { dir, state, file, env, health };
}

test('HTTP checks version and state before consuming; never retries broken poll responses', async t => {
  const x = await fixture(t); let polls = 0;
  const fetch = async url => {
    if (new URL(url).pathname === '/health') return Response.json(x.health);
    polls++; return new Response('{truncated');
  };
  const client = createLavishClient({ env: x.env, fetch });
  x.health.version = '99.0.0';
  await assert.rejects(client.poll(x.file, 'test'), /UNSUPPORTED_LAVISH/); assert.equal(polls, 0);
  x.health.version = supportedLavishVersion; x.health.state_id = 'another-state';
  await assert.rejects(client.poll(x.file, 'test'), /STATE_MISMATCH/); assert.equal(polls, 0);
  x.health.state_id = keyFor(path.join(await realpath(x.state), 'state.json'));
  await assert.rejects(client.poll(x.file, 'test'), SyntaxError); assert.equal(polls, 1);
});

test('HTTP preserves feedback, listener errors, cancellation, and non-consuming listings', async t => {
  const x = await fixture(t), calls = []; let result = { status: 'feedback', prompts: [{ id: 'p1', prompt: 'Keep exactly', tag: 'save', target: { path: 'odd path' } }], artifact_failures: [{ kind: 'load', detail: 'missing' }], session_ended: true, ended_by: 'user', dom_snapshot: '<main>' };
  const controller = new AbortController();
  const client = createLavishClient({ env: x.env, signal: controller.signal, fetch: async (url, options) => {
    calls.push([new URL(url), options]);
    return Response.json(new URL(url).pathname === '/health' ? x.health : result, { status: result.code === 'LISTENER_ACTIVE' && new URL(url).pathname !== '/health' ? 409 : 200 });
  } });
  const feedback = await client.poll(x.file, `lavish-kit:${x.file}`);
  assert.deepEqual(feedback.prompts, result.prompts); assert.deepEqual(feedback.artifact_failures, result.artifact_failures);
  assert.equal(feedback.session.session_ended, true); assert.equal(feedback.session.ended_by, 'user');
  assert.equal(calls.at(-1)[0].searchParams.get('owner'), `lavish-kit:${x.file}`);
  assert.equal(calls.at(-1)[0].searchParams.has('takeover'), false); assert.equal(calls.at(-1)[1].signal, controller.signal);
  result = { code: 'LISTENER_ACTIVE', error: 'already owned' }; await assert.rejects(client.poll(x.file, 'other'), /LISTENER_ACTIVE/);
  result = { code: 'LISTENER_REPLACED' }; await assert.rejects(client.poll(x.file, 'test'), /LISTENER_REPLACED/);
  result = { status: 'missing' }; await assert.rejects(client.poll(x.file, 'test'), /NOT_FOUND/);
  await writeFile(path.join(x.state, 'state.json'), JSON.stringify({ sessions: { a: { file: x.file, status: 'open', prompts: ['untouched'] }, b: { file: 'ended.html', status: 'ended' } } }));
  const before = await readFile(path.join(x.state, 'state.json'), 'utf8');
  assert.deepEqual(await client.list(), { sessions: [{ file: x.file, status: 'open' }] });
  assert.equal(await readFile(path.join(x.state, 'state.json'), 'utf8'), before);
  const fallback = [], run = lavishHttpRun({ env: x.env, encode, fetch: async () => Response.json(x.health), run: async (...args) => { fallback.push(args); return { stdout: 'cli' }; } });
  assert.deepEqual(decode((await run('lavish-axi', [])).stdout), { sessions: [{ file: x.file, status: 'open' }] });
  await run('hc', ['ls']); assert.deepEqual(fallback, [['hc', ['ls']]]);
});

test('real pinned Lavish accepts HTTP feedback, exclusive polls, reply, and end', { timeout: 45000 }, async t => {
  const x = await fixture(t);
  const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
  const env = { ...x.env, LAVISH_AXI_PORT: String(port), LAVISH_AXI_HOST: '127.0.0.1', LAVISH_AXI_NO_OPEN: '1' };
  const binary = execFileSync('which', ['lavish-axi'], { encoding: 'utf8' }).trim();
  const child = spawn(binary, ['server', '--port', String(port)], { env, stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { child.kill('SIGTERM'); await exited; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(ready, 'real Lavish server starts');
  const post = async (route, body) => { const res = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) }); assert.ok(res.ok, `${route}: ${res.status}`); return res.json(); };
  const opened = await post('/api/sessions', { file: x.file });
  const client = createLavishClient({ env });
  assert.equal((await client.list()).sessions[0].file, x.file);
  const polling = client.poll(x.file, 'http-contract');
  t.after(() => polling.catch(() => {}));
  for (let i = 0; i < 100; i++) {
    const health = await (await fetch(`${base}/health`)).json();
    if (health.listeners.some(listener => listener.label === 'http-contract')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await assert.rejects(client.poll(x.file, 'second-owner', { timeoutMs: 0 }), /LISTENER_ACTIVE/);
  await post(`/api/${opened.key}/prompts`, { prompts: [{ prompt: 'HTTP feedback preserves bytes: 雪', tag: 'probe' }] });
  const received = await polling; assert.equal(received.session.status, 'feedback'); assert.equal(received.prompts[0].prompt, 'HTTP feedback preserves bytes: 雪');
  assert.equal((await client.reply(x.file, 'Accepted over HTTP')).status, 'sent');
  assert.equal((await client.poll(x.file, 'next', { timeoutMs: 0 })).session.status, 'waiting');
  assert.equal((await client.end(x.file)).status, 'ended');
  assert.deepEqual(await client.list(), { sessions: [] });
});
