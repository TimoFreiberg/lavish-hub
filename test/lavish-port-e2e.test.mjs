import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { lavishCli } from '../src/runtime.mjs';

const exec = promisify(execFile);
const moduleUrl = pathToFileURL(path.resolve('src/lavish.mjs')).href;
const resolverUrl = pathToFileURL(path.resolve('src/lavish-port.mjs')).href;
const openScript = `import { prepareReview } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await prepareReview(process.argv[1])));`;
const resolveScript = `import { resolveLavishPort } from ${JSON.stringify(resolverUrl)}; console.log(await resolveLavishPort());`;
const run = (script, args, env) => exec(process.execPath, ['--input-type=module', '-e', script, ...args], { env, timeout: 30000 });

test('fallback server is shared by concurrent startup and later commands', { timeout: 90000 }, async t => {
  let resets = 0;
  const foreign = createServer(socket => { resets++; socket.on('error', () => {}); socket.resetAndDestroy(); });
  try { await new Promise((resolve, reject) => foreign.once('error', reject).listen(4388, '127.0.0.1', resolve)); }
  catch (error) { if (error.code === 'EADDRINUSE') return t.skip('port 4388 is already occupied'); throw error; }
  t.after(() => new Promise(resolve => foreign.close(resolve)));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lavish-port-e2e-'));
  const env = { ...process.env, LAVISH_AXI_STATE_DIR: path.join(directory, 'state'), LAVISH_AXI_TELEMETRY: '0', LAVISH_AXI_HOST: '127.0.0.1' };
  delete env.LAVISH_AXI_PORT;
  t.after(async () => {
    try { const { stdout } = await run(resolveScript, [], env); await exec(process.execPath, [lavishCli, 'stop'], { env: { ...env, LAVISH_AXI_PORT: stdout.trim() }, timeout: 10000 }); } catch {}
    await rm(directory, { recursive: true, force: true });
  });
  const files = [path.join(directory, 'one.html'), path.join(directory, 'two.html')];
  await Promise.all(files.map(file => writeFile(file, '<!doctype html><title>Test</title>')));
  const results = await Promise.all(files.map(file => run(openScript, [file], env)));
  const ports = results.map(result => Number(new URL(JSON.parse(result.stdout).url).port));
  assert.equal(ports[0], ports[1]);
  assert.notEqual(ports[0], 4388);
  assert.ok(resets > 0);
  assert.equal(Number((await run(resolveScript, [], env)).stdout.trim()), ports[0]);
  const urlModule = pathToFileURL(path.resolve('src/hub-url.mjs')).href;
  const urlScript = `import { computeHubUrl } from ${JSON.stringify(urlModule)}; console.log(await computeHubUrl({ directory: process.argv[1] }, { detect: async () => null }));`;
  assert.equal(Number(new URL((await run(urlScript, [directory], env)).stdout.trim()).port), ports[0]);
  const conflict = { ...env, LAVISH_AXI_PORT: String(ports[0] + 30) };
  await assert.rejects(run(openScript, [files[0]], conflict), /already uses this state directory/);
});
