import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { encode, decode } from '@toon-format/toon';
import { createLavishClient, lavishHttpRun, stopCommand, supportedLavishVersion } from '../src/lavish-http.mjs';

const keyFor = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
async function fixture(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lavish-http-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = path.join(dir, 'state'); await mkdir(state);
  const file = path.join(dir, 'review.html'); await writeFile(file, '<!doctype html><html lang="en"><title>HTTP probe</title><p>Review</p></html>');
  const env = { ...process.env, LAVISH_AXI_TELEMETRY: '0', LAVISH_AXI_STATE_DIR: state };
  const health = { ok: true, app: 'lavish-axi', version: supportedLavishVersion, lavish_hub_page_reviews: 1, lavish_hub_assets: 1, lavish_hub_batch_replies: 1, state_id: keyFor(path.join(await realpath(state), 'state.json')) };
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
  await assert.rejects(client.poll(x.file, 'test'), error => /UNSUPPORTED_LAVISH/.test(error.message) && !error.ambiguousDelivery); assert.equal(polls, 0);
  x.health.version = supportedLavishVersion; x.health.state_id = 'another-state';
  await assert.rejects(client.poll(x.file, 'test'), error => /STATE_MISMATCH/.test(error.message) && !error.ambiguousDelivery); assert.equal(polls, 0);
  x.health.state_id = keyFor(path.join(await realpath(x.state), 'state.json'));
  await assert.rejects(client.poll(x.file, 'test'), error => error instanceof SyntaxError && error.ambiguousDelivery === true); assert.equal(polls, 1);
});

test('batch replies require capability and classify delivery and session failures', async t => {
  const x = await fixture(t); let response, calls = [];
  const client = createLavishClient({ env: x.env, fetch: async (url, options = {}) => {
    if (new URL(url).pathname === '/health') return Response.json(x.health);
    calls.push(JSON.parse(options.body));
    if (response instanceof Error) throw response;
    return Response.json(response.body, { status: response.status });
  } });
  delete x.health.lavish_hub_batch_replies;
  await assert.rejects(client.reply(x.file, 'hello', { batchId: 'one' }), e => e.code === 'UNSUPPORTED_LAVISH' && /batch-bound/.test(e.message));
  assert.equal(calls.length, 0);
  x.health.lavish_hub_batch_replies = 1;
  response = { status: 200, body: { status: 'sent' } };
  await client.reply(x.file, '- bullet', { batchId: 'one' });
  assert.deepEqual(calls[0], { text: '- bullet', batch_id: 'one' });
  response = { status: 404, body: { code: 'BATCH_NOT_FOUND', error: 'Unknown batch' } };
  await assert.rejects(client.reply(x.file, 'x', { batchId: 'missing' }), e => e.code === 'BATCH_NOT_FOUND' && e.action === 'fix_args');
  response = { status: 409, body: { code: 'BATCH_ALREADY_REPLIED', error: 'Already replied', replied_at: 'today' } };
  await assert.rejects(client.reply(x.file, 'x', { batchId: 'one' }), e => e.code === 'BATCH_ALREADY_REPLIED' && e.action === 'check_delivery' && /today/.test(e.message));
  response = { status: 409, body: { status: 'ended', error: 'Session ended' } };
  await assert.rejects(client.reply(x.file, 'x', { batchId: 'one' }), e => e.code === 'SESSION_ENDED' && e.action === 'reconnect');
  response = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  await assert.rejects(client.reply(x.file, 'x', { batchId: 'one' }), e => e.code === 'REPLY_DELIVERY_UNCERTAIN' && e.action === 'check_delivery');
});

test('hub HTTP requires the patched version and matching state before polling', async t => {
  const x = await fixture(t); let polls = 0;
  const client = createLavishClient({ env: x.env, vendored: true, fetch: async url => {
    if (new URL(url).pathname === '/health') return Response.json(x.health);
    polls++; return Response.json({ status: 'waiting' });
  } });
  delete x.health.lavish_hub_page_reviews;
  // The server is this process's own, so the remedy has to address its state
  // directory and port through the packaged CLI: `lavish-axi` is not on PATH, and a
  // command without those two would reach a different server or none.
  await assert.rejects(client.poll(x.file, 'test'), error => error.code === 'UNSUPPORTED_LAVISH'
    && /the page review routes/.test(error.message)
    && error.message.includes(`LAVISH_AXI_STATE_DIR='${x.state}'`)
    && /LAVISH_AXI_PORT=\d+ node '[^']*vendor\/lavish\/dist\/cli\.mjs' stop$/.test(error.message)
    && !/`lavish-axi stop`/.test(error.message));
  x.health.lavish_hub_page_reviews = 1; x.health.state_id = 'other';
  await assert.rejects(client.poll(x.file, 'test'), /STATE_MISMATCH/);
  assert.equal(polls, 0);
  x.health.state_id = keyFor(path.join(await realpath(x.state), 'state.json'));
  assert.equal((await client.poll(x.file, 'test')).session.status, 'waiting');
  assert.equal(polls, 1);
});

test('a same-version server built without the hub asset grant is refused with the shutdown that replaces it', async t => {
  const x = await fixture(t); let polls = 0;
  const client = createLavishClient({ env: x.env, vendored: true, fetch: async url => {
    if (new URL(url).pathname === '/health') return Response.json(x.health);
    polls++; return Response.json({ status: 'waiting' });
  } });
  // An owner that started from an earlier build of the vendored server answers the
  // supported version and the older patch, so the missing grant is the only sign it
  // cannot serve hub renderers.
  delete x.health.lavish_hub_assets;
  await assert.rejects(client.poll(x.file, 'test'), error => error.code === 'UNSUPPORTED_LAVISH'
    && /hub asset origin grant/.test(error.message)
    // A hub restart keeps the server, so the remedy is the packaged CLI's own
    // shutdown, run against the state directory and port this process uses.
    && error.message.includes(`LAVISH_AXI_STATE_DIR='${x.state}'`)
    && /LAVISH_AXI_PORT=\d+ node '[^']*vendor\/lavish\/dist\/cli\.mjs' stop$/.test(error.message)
    && !/`lavish-axi stop`/.test(error.message));
  assert.equal(polls, 0, 'nothing is consumed from a server that cannot serve the page');
  // Both markers missing names both, so the refusal says everything the adopted
  // server lacks and still sends it nothing.
  delete x.health.lavish_hub_page_reviews;
  await assert.rejects(client.poll(x.file, 'test'), error => error.code === 'UNSUPPORTED_LAVISH'
    && /lacks the page review routes and the hub asset origin grant/.test(error.message));
  assert.equal(polls, 0, 'a server missing either marker is never asked for work');
  x.health.lavish_hub_page_reviews = 1;
  x.health.lavish_hub_assets = 1;
  assert.equal((await client.poll(x.file, 'test')).session.status, 'waiting');
  assert.equal(polls, 1);
});

test('the printed shutdown runs verbatim from a state directory and CLI path with spaces and quotes', async t => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stop-quote-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = path.join(dir, "state dir with space and 'quote'"); await mkdir(state);
  // A stub stands in for the packaged CLI so the test reads back what a pasted run
  // delivers: the argument vector, and the state directory and port the shutdown has
  // to carry to reach this process's server rather than a default one.
  const cli = path.join(dir, "cli with space and 'quote'.mjs");
  await writeFile(cli, 'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), state: process.env.LAVISH_AXI_STATE_DIR, port: process.env.LAVISH_AXI_PORT }));\n');
  const child = spawn('sh', ['-c', stopCommand({ cli, directory: state, port: 4399 })], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  assert.equal(await new Promise(resolve => child.on('exit', resolve)), 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { args: ['stop'], state, port: '4399' });
});

test('hub registration recognizes only the specific ended-session response', async t => {
  const x = await fixture(t);
  const transport = { url: 'http://127.0.0.1:1234', capability: 'a'.repeat(64), resourceKey: 'b'.repeat(64), identityKey: 'c'.repeat(64) };
  let registration = { status: 404, body: { code: 'HUB_SESSION_ENDED', error: 'Session not active' } }, healthFailure = false;
  const client = createLavishClient({ env: x.env, fetch: async url => {
    if (new URL(url).pathname === '/health') return healthFailure ? Response.json(registration.body, { status: registration.status }) : Response.json(x.health);
    return Response.json(registration.body, { status: registration.status });
  } });
  assert.equal(await client.registerHub(x.file, transport), false);
  healthFailure = true;
  await assert.rejects(client.registerHub(x.file, transport), error => error.code === 'HUB_SESSION_ENDED' && error.status === 404);
  healthFailure = false;
  registration = { status: 404, body: { error: 'Session not active' } };
  await assert.rejects(client.registerHub(x.file, transport), error => error.code === 'NOT_FOUND');
  registration = { status: 500, body: { code: 'HUB_SESSION_ENDED', error: 'Session not active' } };
  await assert.rejects(client.registerHub(x.file, transport), error => error.status === 500);
  registration = { status: 404, body: { code: 'HUB_SESSION_ENDED', error: 'Other problem' } };
  await assert.rejects(client.registerHub(x.file, transport), /Other problem/);
  registration = { status: 200, body: { ok: true } };
  assert.equal(await client.registerHub(x.file, transport), true);
});

test('vendored preflight only permits refusal or a compatible server', async t => {
  const x = await fixture(t); let calls = 0;
  const refused = createLavishClient({ env: x.env, vendored: true, fetch: async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  } });
  assert.equal(await refused.verifyIfRunning(), null);
  await assert.rejects(refused.poll(x.file, 'test'), error => error.code === 'LAVISH_CONNECTION_ERROR'
    && error.cause.code === 'ECONNREFUSED'
    && /Cannot connect to Lavish at http:\/\/127\.0\.0\.1:\d+/.test(error.message)
    && /LAVISH_AXI_PORT/.test(error.message));
  const client = createLavishClient({ env: x.env, vendored: true, fetch: async (url, options) => {
    calls++;
    assert.equal(new URL(url).pathname, '/health');
    assert.equal(options.method, undefined);
    return Response.json(x.health);
  } });
  delete x.health.lavish_hub_page_reviews;
  await assert.rejects(client.verifyIfRunning(), /UNSUPPORTED_LAVISH/);
  x.health.lavish_hub_page_reviews = 1;
  x.health.state_id = 'other';
  await assert.rejects(client.verifyIfRunning(), /STATE_MISMATCH/);
  x.health.state_id = keyFor(path.join(await realpath(x.state), 'state.json'));
  assert.equal((await client.verifyIfRunning()).ok, true);
  assert.equal(calls, 3);
  const malformed = createLavishClient({ env: x.env, vendored: true, fetch: async () => new Response('not json') });
  await assert.rejects(malformed.verifyIfRunning(), SyntaxError);
  const timeout = createLavishClient({ env: x.env, vendored: true, fetch: async () => { throw new Error('timeout'); } });
  await assert.rejects(timeout.verifyIfRunning(), /timeout/);
});

test('HTTP preserves feedback, listener errors, cancellation, and non-consuming listings', async t => {
  const x = await fixture(t), calls = []; let result = { status: 'feedback', prompts: [{ id: 'p1', prompt: 'Keep exactly', tag: 'save', target: { path: 'odd path' } }], artifact_failures: [{ kind: 'load', detail: 'missing' }], session_ended: true, ended_by: 'user', dom_snapshot: '<main>', snapshot_page: 'tasks.html' };
  const controller = new AbortController();
  const client = createLavishClient({ env: x.env, signal: controller.signal, fetch: async (url, options) => {
    calls.push([new URL(url), options]);
    return Response.json(new URL(url).pathname === '/health' ? x.health : result, { status: result.code === 'LISTENER_ACTIVE' && new URL(url).pathname !== '/health' ? 409 : 200 });
  } });
  const feedback = await client.poll(x.file, `lavish-hub:${x.file}`);
  assert.deepEqual(feedback.prompts, result.prompts); assert.deepEqual(feedback.artifact_failures, result.artifact_failures);
  assert.equal(feedback.snapshot_page, 'tasks.html');
  assert.equal(feedback.session.session_ended, true); assert.equal(feedback.session.ended_by, 'user');
  assert.equal(calls.at(-1)[0].searchParams.get('owner'), `lavish-hub:${x.file}`);
  assert.equal(calls.at(-1)[0].searchParams.has('takeover'), false); assert.equal(calls.at(-1)[1].signal, controller.signal);
  result = { code: 'LISTENER_ACTIVE', error: 'already owned' }; await assert.rejects(client.poll(x.file, 'other'), error => /LISTENER_ACTIVE/.test(error.message) && !error.ambiguousDelivery);
  result = { code: 'LISTENER_REPLACED' }; await assert.rejects(client.poll(x.file, 'test'), error => /LISTENER_REPLACED/.test(error.message) && !error.ambiguousDelivery);
  result = { status: 'missing' }; await assert.rejects(client.poll(x.file, 'test'), error => /NOT_FOUND/.test(error.message) && !error.ambiguousDelivery);
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
  const binary = path.resolve('vendor/lavish/dist/cli.mjs');
  const child = spawn(process.execPath, [binary, 'server', '--port', String(port)], { env, stdio: 'ignore' });
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
