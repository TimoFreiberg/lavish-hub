import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { supportedLavishVersion } from '../src/lavish-http.mjs';

async function fakeServer(t, health, calls) {
  const state = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hub-opening-')));
  t.after(() => rm(state, { recursive: true, force: true }));
  const state_id = createHash('sha256').update(path.join(state, 'state.json')).digest('hex').slice(0, 16);
  const server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, app: 'lavish-axi', state_id, ...health }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { port: server.address().port, state };
}

async function prepareReview({ port, state }) {
  const module = pathToFileURL(path.resolve('src/lavish.mjs')).href;
  const script = `import { prepareReview } from ${JSON.stringify(module)}; await prepareReview('page.html', { vendored: true });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, LAVISH_AXI_PORT: String(port), LAVISH_AXI_STATE_DIR: state }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  return { code, stderr };
}

test('vendored opening refuses an incompatible occupied port before registration', async t => {
  const calls = [];
  const port = await fakeServer(t, { version: '0.1.96' }, calls);
  const { code, stderr } = await prepareReview(port);
  assert.notEqual(code, 0);
  assert.match(stderr, /UNSUPPORTED_LAVISH/);
  assert.ok(calls.length >= 2 && calls.every(call => call === 'GET /health'));
});

test('a server built without the hub asset grant is named with the shutdown that replaces it', async t => {
  const calls = [];
  // The supported version and the older patch both match, so nothing but the missing
  // grant marks this server as one started before the hub page could fetch its
  // renderer bundles.
  const port = await fakeServer(t, { version: supportedLavishVersion, lavish_kit_page_reviews: 1 }, calls);
  const { code, stderr } = await prepareReview(port);
  assert.notEqual(code, 0);
  assert.match(stderr, /UNSUPPORTED_LAVISH/);
  assert.match(stderr, /hub asset origin grant/);
  // The remedy is the packaged CLI's shutdown, run against this process's port: a hub
  // restart only replaces the owner and keeps adopting this server, and `lavish-axi`
  // is not on PATH, so a bare stop would reach the default state directory instead.
  assert.match(stderr, /LAVISH_AXI_PORT=\d+ node '[^']*vendor\/lavish\/dist\/cli\.mjs' stop/);
  assert.doesNotMatch(stderr, /`lavish-axi stop`/);
  assert.ok(calls.length >= 2 && calls.every(call => call === 'GET /health'));
});
