import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { prepareReview } from '../src/lavish.mjs';
import { resolveLavishPort } from '../src/lavish-port.mjs';

test('a listener winning after port selection does not poison the port record', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lavish-race-'));
  const prior = process.env.LAVISH_AXI_STATE_DIR, priorPort = process.env.LAVISH_AXI_PORT;
  process.env.LAVISH_AXI_STATE_DIR = dir;
  delete process.env.LAVISH_AXI_PORT;
  t.after(async () => { if (prior === undefined) delete process.env.LAVISH_AXI_STATE_DIR; else process.env.LAVISH_AXI_STATE_DIR = prior; if (priorPort === undefined) delete process.env.LAVISH_AXI_PORT; else process.env.LAVISH_AXI_PORT = priorPort; await rm(dir, { recursive: true, force: true }); });
  const server = createServer(socket => { socket.on('error', () => {}); socket.resetAndDestroy(); });
  const spare = createServer();
  await new Promise(resolve => spare.listen(0, '127.0.0.1', resolve));
  const first = spare.address().port;
  await new Promise(resolve => spare.close(resolve));
  const other = createServer();
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  const second = other.address().port;
  await new Promise(resolve => other.close(resolve));
  let selections = 0;
  const resolvePort = async (env, options) => {
    const port = await resolveLavishPort(env, { ...options, ports: [first, second] });
    if (++selections === 1) await new Promise(resolve => server.listen(first, '127.0.0.1', resolve));
    return port;
  };
  t.after(() => new Promise(resolve => server.close(resolve)));
  const review = await prepareReview('page.html', { resolvePort, run: async (_node, _args, { env }) => ({ stdout: `url: http://127.0.0.1:${env.LAVISH_AXI_PORT}/session/test\n` }) });
  assert.equal(new URL(review.url).port, String(second));
  assert.equal(JSON.parse(await readFile(path.join(dir, 'port.json'), 'utf8')).port, second);
  const late = createServer(socket => { socket.on('error', () => {}); socket.resetAndDestroy(); });
  t.after(() => new Promise(resolve => late.close(resolve)));
  await assert.rejects(prepareReview('page.html', {
    resolvePort,
    run: async () => {
      await new Promise(resolve => late.listen(second, '127.0.0.1', resolve));
      throw new Error('launch outcome unknown');
    },
  }), /launch outcome unknown/);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'port.json'), 'utf8')).port, second);
  await assert.rejects(resolvePort(process.env, { locked: true }), /recorded port/);
});
