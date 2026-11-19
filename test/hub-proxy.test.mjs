import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import { createHubTransport } from '../src/hub-transport.mjs';
import { createHubProxy } from '../vendor/lavish/src/hub-proxy.js';

const key = 'a'.repeat(16);
const secret = c => c.repeat(64);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

test('hub proxy confines actions and resources to an active authenticated registration', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-proxy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'review.html');
  await writeFile(source, '<p>source</p>');
  await writeFile(path.join(dir, 'asset.svg'), '<svg/>');
  let actions = 0, release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const transport = await createHubTransport({ save: body => { actions++; return body.value; }, hold: async () => { entered(); await held; return 'original'; } }, { resource: id => id === 'doc' ? source : null });
  t.after(() => transport.close());
  const events = new EventEmitter();
  let active = true;
  const app = express();
  const proxy = createHubProxy({ store: { findByKey: async k => k === key && active ? { status: 'open' } : null }, events, jsonParser: express.json({ limit: '4kb' }) });
  app.post('/register', proxy.control, proxy.register);
  app.post('/unregister', proxy.control, proxy.unregister);
  app.use('/hub-proxy', proxy.handle);
  const server = http.createServer(app), port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  const registration = { key, port: Number(new URL(transport.url).port), capability: transport.capability, resourceKey: transport.resourceKey, identityKey: transport.identityKey };
  const control = (route, body, extra = {}) => fetch(`${base}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  assert.equal((await control('register', registration, { origin: 'null' })).status, 403);
  assert.equal((await control('register', registration, { referer: 'http://example.test/' })).status, 403);
  assert.equal((await control('register', registration, { 'x-forwarded-for': '127.0.0.1' })).status, 403);
  assert.equal((await control('register', { ...registration, port: 0 })).status, 400);
  assert.equal((await control('register', { ...registration, key: 'b'.repeat(16) })).status, 404);
  assert.equal((await control('register', registration)).status, 200);
  const url = `${base}/hub-proxy/${key}`;
  const action = (capability, origin = 'null') => fetch(`${url}/action`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lavish-capability': capability, origin }, body: JSON.stringify({ operation: 'save', value: 'kept' }) });
  assert.equal((await action(secret('b'))).status, 403);
  assert.equal((await action(transport.capability, 'http://example.test')).status, 403);
  const unknown = await fetch(`${url}/action`, { method: 'POST', headers: { origin: 'null', 'content-type': 'application/json', 'x-lavish-capability': transport.capability }, body: JSON.stringify({ operation: 'unknown' }) });
  assert.equal(unknown.status, 400); assert.equal(actions, 0);
  const oversized = await fetch(`${url}/action`, { method: 'POST', headers: { origin: 'null', 'content-type': 'application/json', 'x-lavish-capability': transport.capability }, body: JSON.stringify({ operation: 'save', value: 'x'.repeat(70000) }) });
  assert.equal(oversized.status, 413); assert.equal(actions, 0);
  const preflight = await fetch(`${url}/action`, { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-lavish-capability' } });
  assert.equal(preflight.status, 204);
  assert.equal((await fetch(`${url}/action`, { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' } })).status, 403);
  const result = await action(transport.capability);
  assert.equal(result.status, 200); assert.equal((await result.json()).result, 'kept'); assert.equal(actions, 1);
  const resource = `${url}/resources/${transport.resourceKey}/doc/asset.svg`;
  const asset = await fetch(`${resource}?v=1`, { headers: { origin: 'null' } });
  assert.equal(asset.status, 200); assert.equal(await asset.text(), '<svg/>');
  assert.equal((await fetch(`${url}/action?extra=1`, { method: 'POST', headers: { origin: 'null', 'content-type': 'application/json', 'x-lavish-capability': transport.capability }, body: '{"operation":"save"}' })).status, 404);
  assert.match(asset.headers.get('content-security-policy'), /^sandbox /);
  assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(resource.replace(transport.resourceKey, secret('d')))).status, 404);
  assert.equal((await fetch(`${url}/resources/${transport.resourceKey}/doc/%2fetc`)).status, 404);
  assert.equal((await fetch(`${url}/identity/${secret('e')}`)).status, 404);
  assert.equal((await control('unregister', { key, identityKey: secret('f') })).status, 200);
  assert.equal((await action(transport.capability)).status, 200);
  const inFlight = fetch(`${url}/action`, { method: 'POST', headers: { origin: 'null', 'content-type': 'application/json', 'x-lavish-capability': transport.capability }, body: JSON.stringify({ operation: 'hold' }) });
  await started;
  const replacement = await createHubTransport({ save: body => ({ replacement: body.value }) });
  t.after(() => replacement.close());
  const next = { key, port: Number(new URL(replacement.url).port), capability: replacement.capability, resourceKey: replacement.resourceKey, identityKey: replacement.identityKey };
  assert.equal((await control('register', next)).status, 200);
  release();
  assert.equal((await (await inFlight).json()).result, 'original');
  assert.equal((await control('unregister', { key, identityKey: transport.identityKey })).status, 200);
  assert.equal((await action(transport.capability)).status, 403);
  const replacementResult = await action(replacement.capability);
  assert.deepEqual((await replacementResult.json()).result, { replacement: 'kept' });
  events.emit('ended', key);
  assert.equal((await action(transport.capability)).status, 404);
  active = false;
  assert.equal((await control('register', registration)).status, 404);
});

test('dashboard exposes only live display metadata and relative session links', async t => {
  const events = new EventEmitter();
  const app = express();
  const proxy = createHubProxy({ store: { findByKey: async () => ({ status: 'open' }) }, events, jsonParser: express.json() });
  app.post('/register', proxy.control, proxy.register); app.get('/hubs', proxy.dashboard);
  const server = http.createServer(app), port = await listen(server); t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  const registration = { key, port: 1234, capability: secret('a'), resourceKey: secret('b'), identityKey: secret('c'), display: { label: '<workspace>', summary: 'first', extra: secret('d') } };
  const register = body => fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const list = async () => (await (await fetch(`${base}/hubs`)).json()).hubs;
  assert.deepEqual(await list(), []);
  assert.equal((await register(registration)).status, 200);
  assert.deepEqual(await list(), [{ label: '<workspace>', summary: 'first', url: `/session/${key}` }]);
  assert.equal((await register({ ...registration, display: { label: 'next', summary: null } })).status, 200);
  assert.deepEqual(await list(), [{ label: 'next', summary: null, url: `/session/${key}` }]);
  const original = Date.now;
  try { Date.now = () => original() + 46000; assert.deepEqual(await list(), []); } finally { Date.now = original; }
  assert.equal((await register(registration)).status, 200);
  events.emit('ended', key);
  assert.deepEqual(await list(), []);
});

test('resource query is preserved upstream', async t => {
  const identityKey = secret('c'), resourceKey = secret('b');
  const target = http.createServer((req, res) => {
    if (req.url.startsWith('/identity/')) {
      const challenge = req.url.split('/').at(-1);
      res.end(JSON.stringify({ proof: createHmac('sha256', identityKey).update(challenge).digest('hex') }));
    } else res.end(req.url);
  });
  const targetPort = await listen(target); t.after(() => close(target));
  const app = express();
  const proxy = createHubProxy({ store: { findByKey: async () => ({ status: 'open' }) }, events: new EventEmitter(), jsonParser: express.json() });
  app.post('/register', proxy.control, proxy.register); app.use('/hub-proxy', proxy.handle);
  const server = http.createServer(app), port = await listen(server); t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, port: targetPort, capability: secret('a'), resourceKey, identityKey }) });
  const route = `/resources/${resourceKey}/doc/asset.css?v=1&x=%2F`;
  const response = await fetch(`${base}/hub-proxy/${key}${route}`);
  assert.equal(response.status, 200); assert.equal(await response.text(), route);
});

test('identical registration preserves pending actions but replacement invalidates them', async t => {
  let calls = 0, holdNext = false, notify;
  let entered;
  function holdLookup() {
    holdNext = true;
    entered = new Promise(resolve => { notify = resolve; });
  }
  const old = await createHubTransport({ save: () => { calls++; return 'old'; } }); t.after(() => old.close());
  const replacement = await createHubTransport({ save: () => 'new' }); t.after(() => replacement.close());
  const app = express();
  const proxy = createHubProxy({ store: { findByKey: async () => { if (holdNext) { holdNext = false; notify(); await new Promise(resolve => { unblock = resolve; }); } return { status: 'open' }; } }, events: new EventEmitter(), jsonParser: express.json() });
  let unblock;
  app.post('/register', proxy.control, proxy.register); app.use('/hub-proxy', proxy.handle);
  const server = http.createServer(app), port = await listen(server); t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  const params = transport => ({ key, port: Number(new URL(transport.url).port), capability: transport.capability, resourceKey: transport.resourceKey, identityKey: transport.identityKey });
  const register = transport => fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params(transport)) });
  const action = () => fetch(`${base}/hub-proxy/${key}/action`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lavish-capability': old.capability }, body: '{"operation":"save"}' });
  assert.equal((await register(old)).status, 200);
  holdLookup();
  const same = action(); await entered;
  assert.equal((await register(old)).status, 200);
  unblock();
  assert.equal((await same).status, 200); assert.equal(calls, 1);
  holdLookup();
  const replaced = action(); await entered;
  assert.equal((await register(replacement)).status, 200);
  unblock();
  assert.equal((await replaced).status, 404); assert.equal(calls, 1);
});

test('replacement during identity verification prevents dispatch', async t => {
  let release, notify, dispatched = false;
  const entered = new Promise(resolve => { notify = resolve; });
  const identityKey = secret('c'), capability = secret('a');
  const target = http.createServer(async (req, res) => {
    if (!req.url.startsWith('/identity/')) { dispatched = true; res.end('{}'); return; }
    const challenge = req.url.split('/').at(-1);
    await new Promise(resolve => { release = resolve; notify(); });
    res.end(JSON.stringify({ proof: createHmac('sha256', identityKey).update(challenge).digest('hex') }));
  });
  const targetPort = await listen(target); t.after(() => close(target));
  const replacement = await createHubTransport({ save: () => 'new' }); t.after(() => replacement.close());
  const app = express();
  const proxy = createHubProxy({ store: { findByKey: async () => ({ status: 'open' }) }, events: new EventEmitter(), jsonParser: express.json() });
  app.post('/register', proxy.control, proxy.register); app.use('/hub-proxy', proxy.handle);
  const server = http.createServer(app), port = await listen(server); t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  const register = body => fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await register({ key, port: targetPort, capability, resourceKey: secret('b'), identityKey });
  const action = fetch(`${base}/hub-proxy/${key}/action`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lavish-capability': capability }, body: '{"operation":"save"}' });
  await entered;
  assert.equal((await register({ key, port: Number(new URL(replacement.url).port), capability: replacement.capability, resourceKey: replacement.resourceKey, identityKey: replacement.identityKey })).status, 200);
  release();
  assert.equal((await action).status, 404); assert.equal(dispatched, false);
});

test('registration distinguishes an ended session from other refusals', async t => {
  const app = express();
  const proxy = createHubProxy({ store: { findByKey: async k => k === key ? { status: 'ended' } : null }, events: new EventEmitter(), jsonParser: express.json() });
  app.post('/register', proxy.control, proxy.register);
  const server = http.createServer(app), port = await listen(server); t.after(() => close(server));
  const register = k => fetch(`http://127.0.0.1:${port}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: k, port: 1234, capability: secret('a'), resourceKey: secret('b'), identityKey: secret('c') }) });
  const ended = await register(key);
  assert.equal(ended.status, 404); assert.equal((await ended.json()).code, 'HUB_SESSION_ENDED');
  const missing = await register('b'.repeat(16));
  assert.equal(missing.status, 404); assert.notEqual((await missing.json()).code, 'HUB_SESSION_ENDED');
});

test('an end during registration cannot restore the target', async t => {
  let unblock, notify;
  const entered = new Promise(resolve => { notify = resolve; });
  const wait = new Promise(resolve => { unblock = resolve; });
  const events = new EventEmitter();
  const app = express();
  const proxy = createHubProxy({ store: { findByKey: async () => { notify(); await wait; return { status: 'open' }; } }, events, jsonParser: express.json() });
  app.post('/register', proxy.control, proxy.register); app.use('/hub-proxy', proxy.handle);
  const server = http.createServer(app), port = await listen(server); t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  const registration = fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, port: 1234, capability: secret('a'), resourceKey: secret('b'), identityKey: secret('c') }) });
  await entered;
  events.emit('ended', key);
  unblock();
  assert.equal((await registration).status, 404);
  assert.equal((await fetch(`${base}/hub-proxy/${key}/action`, { method: 'POST' })).status, 404);
});

test('hub proxy never reconnects after authenticating a socket', async t => {
  let receivedCapability = false;
  const identityKey = secret('c');
  const target = http.createServer((req, res) => {
    if (req.headers['x-lavish-capability']) receivedCapability = true;
    const challenge = req.url.split('/').at(-1);
    res.setHeader('connection', 'close');
    res.end(JSON.stringify({ proof: createHmac('sha256', identityKey).update(challenge).digest('hex') }));
  });
  const targetPort = await listen(target); t.after(() => close(target));
  const app = express();
  const proxy = createHubProxy({ store: { findByKey: async () => ({ status: 'open' }) }, events: new EventEmitter(), jsonParser: express.json() });
  app.post('/register', proxy.control, proxy.register); app.use('/hub-proxy', proxy.handle);
  const server = http.createServer(app), port = await listen(server); t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, port: targetPort, capability: secret('a'), resourceKey: secret('b'), identityKey }) });
  const result = await fetch(`${base}/hub-proxy/${key}/action`, { method: 'POST', headers: { origin: 'null', 'content-type': 'application/json', 'x-lavish-capability': secret('a') }, body: '{"operation":"save"}' });
  assert.equal(result.status, 502); assert.equal(receivedCapability, false);
});

test('hub proxy refuses an unrelated process at a registered port', async t => {
  let captured = false;
  const other = http.createServer((req, res) => { if (req.headers['x-lavish-capability']) captured = true; res.end('{}'); });
  const targetPort = await listen(other); t.after(() => close(other));
  const app = express();
  const proxy = createHubProxy({ store: { findByKey: async () => ({ status: 'open' }) }, events: new EventEmitter(), jsonParser: express.json() });
  app.post('/register', proxy.control, proxy.register); app.use('/hub-proxy', proxy.handle);
  const server = http.createServer(app), port = await listen(server); t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, port: targetPort, capability: secret('a'), resourceKey: secret('b'), identityKey: secret('c') }) });
  const result = await fetch(`${base}/hub-proxy/${key}/action`, { method: 'POST', headers: { origin: 'null', 'content-type': 'application/json', 'x-lavish-capability': secret('a') }, body: '{"operation":"save"}' });
  assert.equal(result.status, 502); assert.equal(captured, false);
});

// A browser that leaves while the session lookup is still pending must not
// cause owner work for a response nobody will read.
async function heldProxy(t) {
  let entered, release, armed = false;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let observed;
  const disconnected = new Promise(resolve => { observed = resolve; });
  const seen = [];
  const identityKey = secret('c');
  const target = http.createServer((req, res) => {
    seen.push(req.url);
    const challenge = req.url.split('/').at(-1);
    res.end(JSON.stringify({ proof: createHmac('sha256', identityKey).update(challenge).digest('hex') }));
  });
  const targetPort = await listen(target); t.after(() => close(target));
  const app = express();
  const proxy = createHubProxy({
    store: { findByKey: async () => { if (!armed) return { status: 'open' }; armed = false; entered(); await held; return { status: 'open' }; } },
    events: new EventEmitter(),
    jsonParser: express.json(),
  });
  app.use('/hub-proxy', (req, res, next) => { res.once('close', observed); next(); });
  app.post('/register', proxy.control, proxy.register); app.use('/hub-proxy', proxy.handle);
  const server = http.createServer(app), port = await listen(server); t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  const registration = { key, port: targetPort, capability: secret('a'), resourceKey: secret('b'), identityKey };
  assert.equal((await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(registration) })).status, 200);
  return {
    base, seen, started, disconnected, release,
    resourcePath: `/resources/${registration.resourceKey}/doc/asset.svg`,
    arm: () => { armed = true; },
  };
}

test('a client disconnect during session lookup never reaches the owner', { timeout: 10000 }, async t => {
  const hub = await heldProxy(t);
  hub.arm();
  const controller = new AbortController();
  const abandoned = fetch(`${hub.base}/hub-proxy/${key}${hub.resourcePath}`, { signal: controller.signal }).catch(() => 'aborted');
  await hub.started;
  controller.abort();
  assert.equal(await abandoned, 'aborted');
  await hub.disconnected;
  hub.release();
  await delay(200);
  assert.deepEqual(hub.seen, []);
});

test('a client disconnect during session lookup never forwards an action', { timeout: 10000 }, async t => {
  const hub = await heldProxy(t);
  hub.arm();
  const controller = new AbortController();
  const abandoned = fetch(`${hub.base}/hub-proxy/${key}/action`, { method: 'POST', headers: { origin: 'null', 'content-type': 'application/json', 'x-lavish-capability': secret('a') }, body: '{"operation":"save"}', signal: controller.signal }).catch(() => 'aborted');
  await hub.started;
  controller.abort();
  assert.equal(await abandoned, 'aborted');
  await hub.disconnected;
  hub.release();
  await delay(200);
  assert.deepEqual(hub.seen, []);
});

test('a resource request is bounded more tightly than an action', { timeout: 10000 }, async t => {
  const identityKey = secret('c'), capability = secret('a'), resourceKey = secret('b');
  const dispatched = [];
  const target = http.createServer(async (req, res) => {
    if (req.url.startsWith('/identity/')) {
      const challenge = req.url.split('/').at(-1);
      res.end(JSON.stringify({ proof: createHmac('sha256', identityKey).update(challenge).digest('hex') }));
      return;
    }
    dispatched.push(req.url);
    if (req.url.startsWith('/resources/')) return;
    await delay(300);
    res.end('{"result":"saved"}');
  });
  const targetPort = await listen(target); t.after(() => close(target));
  const app = express();
  const proxy = createHubProxy({ store: { findByKey: async () => ({ status: 'open' }) }, events: new EventEmitter(), jsonParser: express.json(), limits: { resourceMs: 100, actionMs: 4000, identityMs: 1000 } });
  app.post('/register', proxy.control, proxy.register); app.use('/hub-proxy', proxy.handle);
  const server = http.createServer(app), port = await listen(server); t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, port: targetPort, capability, resourceKey, identityKey }) });
  const start = Date.now();
  const budget = AbortSignal.timeout(3000);
  const outcome = await fetch(`${base}/hub-proxy/${key}/resources/${resourceKey}/doc/asset.svg`, { signal: budget })
    .then(async response => ({ status: response.status, body: await response.json() }), () => ({ failure: true }));
  const elapsed = Date.now() - start;
  assert.equal(budget.aborted, false, 'the proxy must bound the resource request itself');
  assert.equal(outcome.status, 504, `a wedged resource read answers 504, got ${JSON.stringify(outcome)}`);
  assert.equal(outcome.body.error, 'Hub timeout');
  assert.ok(elapsed < 2500, `resource request failed after ${elapsed} ms`);
  const action = await fetch(`${base}/hub-proxy/${key}/action`, { method: 'POST', headers: { origin: 'null', 'content-type': 'application/json', 'x-lavish-capability': capability }, body: '{"operation":"save"}' });
  assert.equal(action.status, 200); assert.equal((await action.json()).result, 'saved');
  assert.equal(dispatched.filter(url => url === '/action').length, 1);
  assert.ok(dispatched[0].startsWith('/resources/'), 'the wedged resource request was forwarded before its bound expired');
});

test('a slow identity round trip does not consume the resource deadline', { timeout: 10000 }, async t => {
  const identityKey = secret('c'), resourceKey = secret('b');
  const target = http.createServer(async (req, res) => {
    if (req.url.startsWith('/identity/')) {
      // Slower than the resource deadline below, so a shared budget would fail.
      await delay(150);
      const challenge = req.url.split('/').at(-1);
      res.end(JSON.stringify({ proof: createHmac('sha256', identityKey).update(challenge).digest('hex') }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/css' });
    res.write('.a{}');
    await delay(150);
    res.write('.b{}');
    await delay(150);
    res.end('.c{}');
  });
  const targetPort = await listen(target); t.after(() => close(target));
  const app = express();
  const proxy = createHubProxy({ store: { findByKey: async () => ({ status: 'open' }) }, events: new EventEmitter(), jsonParser: express.json(), limits: { resourceMs: 100, actionMs: 4000 } });
  app.post('/register', proxy.control, proxy.register); app.use('/hub-proxy', proxy.handle);
  const server = http.createServer(app), port = await listen(server); t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, port: targetPort, capability: secret('a'), resourceKey, identityKey }) });
  const response = await fetch(`${base}/hub-proxy/${key}/resources/${resourceKey}/doc/hub.css`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '.a{}.b{}.c{}');
});

test('an owner that never proves its identity is bounded before dispatch', { timeout: 10000 }, async t => {
  const identityKey = secret('c'), capability = secret('a');
  let dispatched = false;
  const target = http.createServer((req, res) => {
    if (req.url.startsWith('/identity/')) return;
    dispatched = true;
    res.end('{"result":"saved"}');
  });
  const targetPort = await listen(target); t.after(() => close(target));
  const app = express();
  const proxy = createHubProxy({ store: { findByKey: async () => ({ status: 'open' }) }, events: new EventEmitter(), jsonParser: express.json(), limits: { identityMs: 100 } });
  app.post('/register', proxy.control, proxy.register); app.use('/hub-proxy', proxy.handle);
  const server = http.createServer(app), port = await listen(server); t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, port: targetPort, capability, resourceKey: secret('b'), identityKey }) });
  const start = Date.now();
  const budget = AbortSignal.timeout(3000);
  const outcome = await fetch(`${base}/hub-proxy/${key}/action`, { method: 'POST', headers: { origin: 'null', 'content-type': 'application/json', 'x-lavish-capability': capability }, body: '{"operation":"save"}', signal: budget }).then(response => ({ status: response.status }), () => ({ failure: true }));
  const elapsed = Date.now() - start;
  assert.equal(budget.aborted, false, 'the proxy must bound the identity challenge itself');
  assert.equal(outcome.status, 502, `an unanswered identity challenge answers 502, got ${JSON.stringify(outcome)}`);
  assert.ok(elapsed < 2500, `identity challenge failed after ${elapsed} ms`);
  assert.equal(dispatched, false);
});

test('a truncated upstream response never completes as a usable resource', { timeout: 10000 }, async t => {
  const identityKey = secret('c'), resourceKey = secret('b');
  const target = http.createServer((req, res) => {
    if (req.url.startsWith('/identity/')) {
      const challenge = req.url.split('/').at(-1);
      res.end(JSON.stringify({ proof: createHmac('sha256', identityKey).update(challenge).digest('hex') }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/css', 'content-length': '100' });
    res.write('.hub {');
    setTimeout(() => res.socket.destroy(), 20);
  });
  const targetPort = await listen(target); t.after(() => close(target));
  const app = express();
  const proxy = createHubProxy({ store: { findByKey: async () => ({ status: 'open' }) }, events: new EventEmitter(), jsonParser: express.json() });
  app.post('/register', proxy.control, proxy.register); app.use('/hub-proxy', proxy.handle);
  const server = http.createServer(app), port = await listen(server); t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, port: targetPort, capability: secret('a'), resourceKey, identityKey }) });
  const start = Date.now();
  const budget = AbortSignal.timeout(3000);
  const outcome = await fetch(`${base}/hub-proxy/${key}/resources/${resourceKey}/doc/hub.css`, { signal: budget })
    .then(async response => ({ status: response.status, body: await response.text().catch(() => null) }), () => ({ failure: true }));
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2500, `truncated response settled after ${elapsed} ms`);
  assert.ok(outcome.failure || outcome.status !== 200 || outcome.body === null, `a short upstream body must not complete as ${JSON.stringify(outcome)}`);
});

// A GET with a body is unusual but valid, and the resource route never reads it.
// The deadline must still answer, and Node dumps the unread bytes so the
// connection is not left occupied.
test('a resource deadline answers when the request body was never read', { timeout: 10000 }, async t => {
  const identityKey = secret('c'), capability = secret('a'), resourceKey = secret('b');
  const target = http.createServer((req, res) => {
    if (!req.url.startsWith('/identity/')) return;
    const challenge = req.url.split('/').at(-1);
    res.end(JSON.stringify({ proof: createHmac('sha256', identityKey).update(challenge).digest('hex') }));
  });
  const targetPort = await listen(target); t.after(() => close(target));
  const app = express();
  const proxy = createHubProxy({ store: { findByKey: async () => ({ status: 'open' }) }, events: new EventEmitter(), jsonParser: express.json(), limits: { resourceMs: 100 } });
  app.post('/register', proxy.control, proxy.register); app.use('/hub-proxy', proxy.handle);
  const server = http.createServer(app), port = await listen(server); t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, port: targetPort, capability, resourceKey, identityKey }) });
  const outcome = await new Promise(resolve => {
    const request = http.request(`${base}/hub-proxy/${key}/resources/${resourceKey}/doc/asset.svg`, { method: 'GET', headers: { 'content-length': 4096 } }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
      response.on('error', error => resolve({ failure: error.code }));
    });
    request.on('error', error => resolve({ failure: error.code }));
    // Only part of the declared body arrives before the deadline fires.
    request.write(Buffer.alloc(1024, 97));
  });
  assert.equal(outcome.status, 504, `an unread body must not cost the deadline its answer, got ${JSON.stringify(outcome)}`);
  assert.equal(JSON.parse(outcome.text).error, 'Hub timeout');
});

test('an action that never answers is torn down rather than answered', { timeout: 10000 }, async t => {
  const identityKey = secret('c'), capability = secret('a');
  const target = http.createServer((req, res) => {
    if (!req.url.startsWith('/identity/')) return;
    const challenge = req.url.split('/').at(-1);
    res.end(JSON.stringify({ proof: createHmac('sha256', identityKey).update(challenge).digest('hex') }));
  });
  const targetPort = await listen(target); t.after(() => close(target));
  const app = express();
  const proxy = createHubProxy({ store: { findByKey: async () => ({ status: 'open' }) }, events: new EventEmitter(), jsonParser: express.json(), limits: { actionMs: 150, resourceMs: 1000 } });
  app.post('/register', proxy.control, proxy.register); app.use('/hub-proxy', proxy.handle);
  const server = http.createServer(app), port = await listen(server); t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, port: targetPort, capability, resourceKey: secret('b'), identityKey }) });
  const start = Date.now();
  const budget = AbortSignal.timeout(3000);
  const outcome = await fetch(`${base}/hub-proxy/${key}/action`, { method: 'POST', headers: { origin: 'null', 'content-type': 'application/json', 'x-lavish-capability': capability }, body: '{"operation":"save"}', signal: budget })
    .then(response => ({ status: response.status }), () => ({ failure: true }));
  const elapsed = Date.now() - start;
  assert.equal(budget.aborted, false, 'the proxy must bound the action');
  assert.equal(outcome.failure, true, `a mutation deadline keeps the socket teardown, got ${JSON.stringify(outcome)}`);
  assert.ok(elapsed < 2500, `action failed after ${elapsed} ms`);
});

test('a resource transfer that stalls after headers is bounded by the ceiling', { timeout: 10000 }, async t => {
  const identityKey = secret('c'), capability = secret('a'), resourceKey = secret('b');
  const target = http.createServer((req, res) => {
    if (!req.url.startsWith('/identity/')) {
      res.writeHead(200, { 'content-type': 'text/css' });
      res.write('.a{}');
      return;
    }
    const challenge = req.url.split('/').at(-1);
    res.end(JSON.stringify({ proof: createHmac('sha256', identityKey).update(challenge).digest('hex') }));
  });
  const targetPort = await listen(target); t.after(() => close(target));
  const app = express();
  const proxy = createHubProxy({ store: { findByKey: async () => ({ status: 'open' }) }, events: new EventEmitter(), jsonParser: express.json(), limits: { resourceMs: 40, actionMs: 400 } });
  app.post('/register', proxy.control, proxy.register); app.use('/hub-proxy', proxy.handle);
  const server = http.createServer(app), port = await listen(server); t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, port: targetPort, capability, resourceKey, identityKey }) });
  const start = Date.now();
  const budget = AbortSignal.timeout(4000);
  const outcome = await fetch(`${base}/hub-proxy/${key}/resources/${resourceKey}/doc/hub.css`, { signal: budget })
    .then(async response => ({ status: response.status, body: await response.text().catch(() => null) }), () => ({ failure: true }));
  const elapsed = Date.now() - start;
  assert.equal(budget.aborted, false, 'the ceiling must bound the stalled transfer');
  assert.equal(outcome.status, 200, `headers arrive before the stall, got ${JSON.stringify(outcome)}`);
  assert.equal(outcome.body, null, 'a stalled transfer must not complete its body');
  assert.ok(elapsed >= 300, `the resource deadline must not govern a started transfer, failed after ${elapsed} ms`);
});
