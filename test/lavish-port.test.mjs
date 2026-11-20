import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { resolveLavishPort } from '../src/lavish-port.mjs';

test('unrecorded unidentified and legacy listeners do not block fallback', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lavish-port-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { LAVISH_AXI_STATE_DIR: directory };
  const isAvailable = async port => port !== 4388;
  assert.equal(await resolveLavishPort(env, { isAvailable, request: async () => { throw new Error('timeout'); } }), 4389);
  assert.equal(await resolveLavishPort(env, { isAvailable, request: async () => ({ json: async () => ({ app: 'lavish-axi' }) }) }), 4389);
  assert.equal(await resolveLavishPort({ ...env, LAVISH_AXI_PORT: '4388' }, { isAvailable, request: async () => { throw new Error('reset'); } }), 4388);
  assert.equal(await resolveLavishPort(env, { isAvailable, request: async () => ({ json: async () => ({ app: 'other' }) }) }), 4389);
});

test('real TCP reset is skipped unless the port is recorded', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lavish-port-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let resets = 0;
  const server = createServer(socket => { resets++; socket.on('error', () => {}); socket.resetAndDestroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const spare = createServer();
  await new Promise(resolve => spare.listen(0, '127.0.0.1', resolve));
  const fallback = spare.address().port;
  await new Promise(resolve => spare.close(resolve));
  const env = { LAVISH_AXI_STATE_DIR: directory };
  assert.equal(await resolveLavishPort(env, { ports: [port, fallback] }), fallback);
  assert.ok(resets > 0);
  await writeFile(path.join(directory, 'port.json'), JSON.stringify({ port }));
  await assert.rejects(resolveLavishPort(env, { ports: [port, fallback] }), /recorded port/);
});

test('recorded port prevents explicit selection of a second server', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lavish-port-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'port.json'), JSON.stringify({ port: 6123 }));
  await assert.rejects(resolveLavishPort({ LAVISH_AXI_STATE_DIR: directory, LAVISH_AXI_PORT: '6124' }, { isAvailable: async port => port !== 6123, request: async () => { throw new Error('timeout'); } }), /identify/);
  await assert.rejects(resolveLavishPort({ LAVISH_AXI_PORT: '65536' }), /Invalid LAVISH_AXI_PORT/);
});
