import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveWorkspace } from '../src/hub-workspace.mjs';

const cli = path.resolve('bin/lavish-kit');
test('hub foreground owner rejects duplicates and stops without a relay', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-owner-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'), state = path.join(dir, 'lavish'), data = path.join(dir, 'data');
  await mkdir(repo); await mkdir(state);
  execFileSync('jj', ['git', 'init', repo]);
  const canonicalState = await realpath(state);
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') res.end(JSON.stringify({ ok: true, app: 'lavish-axi', version: '0.1.96', state_id: createHash('sha256').update(path.join(canonicalState, 'state.json')).digest('hex').slice(0, 16) }));
    else setTimeout(() => res.end(JSON.stringify({ status: 'waiting' })), 50);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.closeAllConnections() || server.close());
  const stub = path.join(dir, 'lavish-axi');
  await writeFile(stub, '#!/bin/sh\nprintf "url: http://localhost:123/review\\n"\n'); await chmod(stub, 0o700);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, LAVISH_AXI_STATE_DIR: state, LAVISH_AXI_PORT: String(server.address().port), XDG_DATA_HOME: data, XDG_STATE_HOME: path.join(dir, 'xdg-state') };
  delete env.HC_TERMINAL_ID;
  const identity = await resolveWorkspace(repo, env), runtime = path.join(identity.directory, 'owner', 'runtime.json');
  const owner = spawn(process.execPath, [cli, 'hub', 'listen', '--workspace', repo], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; owner.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { if (owner.exitCode === null) owner.kill('SIGKILL'); });
  for (let i = 0; i < 100; i++) { try { await stat(runtime); break; } catch { if (owner.exitCode !== null) throw new Error(stderr); await delay(30); } }
  assert.equal((await stat(runtime)).mode & 0o777, 0o600);
  const run = promisify(execFile);
  await assert.rejects(run(process.execPath, [cli, 'hub', 'listen', '--workspace', repo], { env }), /hub owner is already running/i);
  const { stdout } = await run(process.execPath, [cli, 'hub', '--workspace', repo], { env });
  assert.match(stdout, /Hub owner running/);
  await run(process.execPath, [cli, 'hub', 'stop', '--workspace', repo], { env });
  const exit = await new Promise(resolve => owner.once('exit', resolve));
  assert.equal(exit, 0, stderr);
  await assert.rejects(readFile(runtime), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(env.XDG_STATE_HOME, 'lavish-kit', 'relay.json')), { code: 'ENOENT' });
});
