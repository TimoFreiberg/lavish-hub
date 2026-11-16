// Fixture executables model the CLI; real HTTP contracts have a separate suite.
process.env.LAVISH_KIT_LAVISH_TRANSPORT = 'cli';
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from '@toon-format/toon';
import { claimLock, recordWatch, relayPaths } from '../src/relay.mjs';

const worker = fileURLToPath(new URL('../src/relay-worker.mjs', import.meta.url));
const relay = fileURLToPath(new URL('../src/relay.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../bin/lavish-kit', import.meta.url));
const deps = fileURLToPath(new URL('../src/deps.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('../node_modules', import.meta.url));
const exists = async file => access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
async function until(fn, message = 'condition timed out') {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(message);
}
function run(args, env) {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}
async function success(command) { const result = await command.done; assert.equal(result.code, 0, JSON.stringify(result)); return result; }
async function setup(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lavish-daemon-test-')));
  const bin = path.join(dir, 'bin'), state = path.join(dir, 'lavish'), listing = path.join(dir, 'listing');
  await mkdir(bin);
  const daemonDir = path.join('/tmp', `lavish-kit-${process.getuid()}-${createHash('sha256').update(path.resolve(state)).digest('hex').slice(0, 24)}`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_DATA_HOME: path.join(dir, 'data'), XDG_STATE_HOME: path.join(dir, 'state'), LAVISH_AXI_STATE_DIR: state, HC_TERMINAL_ID: '' };
  const pages = [];
  async function list(open) { await writeFile(listing, encode({ sessions: open.map(file => ({ file, status: 'open' })) })); }
  async function page(name) { const file = path.join(dir, `${name}.html`); await writeFile(file, '<title>Test</title>'); await recordWatch(file, null, false); pages.push(file); return file; }
  await list([]);
  await writeFile(path.join(bin, 'lavish-axi'), `#!${process.execPath}\nconst fs = require('node:fs'); if (process.argv.length === 2) console.log(fs.readFileSync(${JSON.stringify(listing)}, 'utf8')); else console.log('url: http://localhost:123/review');\n`);
  await chmod(path.join(bin, 'lavish-axi'), 0o755);
  const launch = file => run(['--input-type=module', '-e', `import {ensureRelay} from ${JSON.stringify(relay)}; await ensureRelay(${JSON.stringify(file)});`], env);
  t.after(async () => {
    await list([]);
    await until(async () => !(await Promise.all(pages.map(file => exists(relayPaths(file).lock)))).some(Boolean), 'page workers did not exit');
    await until(async () => !await exists(path.join(daemonDir, 'daemon.lock')), 'daemon did not exit');
    await rm(daemonDir, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true });
  });
  // Dependency installation and bundling are not part of daemon startup checks.
  const npm = path.join(bin, 'npm'); await writeFile(npm, '#!/bin/sh\ncp -R "$FIXTURE" node_modules\n'); await chmod(npm, 0o755);
  const init = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(deps)}).then(m=>m.ensureDeps())`], { env: { ...env, FIXTURE: fixture }, encoding: 'utf8', timeout: 40000 });
  assert.equal(init.status, 0, init.stderr);
  return { dir, bin, env, pages, page, list, launch, daemonDir };
}

test('launcher death after worker spawn before bind permits recovery without a second owner', { timeout: 45000 }, async t => {
  const x = await setup(t), file = await x.page('page'), reached = path.join(x.dir, 'reached'), release = path.join(x.dir, 'release');
  await x.list([file]);
  const preload = path.join(x.dir, 'pause.cjs');
  await writeFile(preload, `const fs=require('node:fs'); if(process.argv[1]===${JSON.stringify(worker)}) { fs.writeFileSync(${JSON.stringify(reached)},String(process.pid)); while(!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); }`);
  const launcher = run(['--input-type=module', '-e', `import {ensureRelay} from ${JSON.stringify(relay)}; await ensureRelay(${JSON.stringify(file)});`], { ...x.env, NODE_OPTIONS: `--require=${preload}` });
  try {
    await until(() => exists(reached), 'worker did not reach pre-bind barrier');
    assert.equal(await exists(path.join(x.daemonDir, 'relay.sock')), false);
    launcher.child.kill('SIGKILL'); assert.equal((await launcher.done).signal, 'SIGKILL');
  } finally {
    if (launcher.child.exitCode === null && launcher.child.signalCode === null) { launcher.child.kill('SIGKILL'); await launcher.done; }
    await writeFile(release, '');
  }
  await until(() => exists(path.join(x.daemonDir, 'relay.sock')), 'spawned worker did not bind after launcher death');
  await success(x.launch(file));
  const owner = await readFile(path.join(x.daemonDir, 'daemon.lock', 'pid'), 'utf8');
  assert.equal(owner, await readFile(reached, 'utf8'));
  assert.equal(await readFile(path.join(relayPaths(file).lock, 'pid'), 'utf8'), owner);
  await success(x.launch(file));
  assert.equal(await readFile(path.join(x.daemonDir, 'daemon.lock', 'pid'), 'utf8'), owner);
});

test('concurrent CLI invocations register pages in one daemon', { timeout: 60000 }, async t => {
  const x = await setup(t), first = await x.page('first'), second = await x.page('second'); await x.list([first, second]);
  const results = await Promise.all([first, second, first, second].map(file => success(run([cli, file], x.env))));
  for (const result of results) assert.match(result.stdout, /Lavish review/);
  const owner = await readFile(path.join(x.daemonDir, 'daemon.lock', 'pid'), 'utf8');
  for (const file of [first, second]) assert.equal(await readFile(path.join(relayPaths(file).lock, 'pid'), 'utf8'), owner);
});

test('state directory aliases share an owner before and after creation', { timeout: 45000 }, async t => {
  const x = await setup(t), first = await x.page('first'), second = await x.page('second');
  const alias = path.join(x.dir, 'alias'); await symlink(x.dir, alias);
  await x.list([first, second]);
  const aliasEnv = { ...x.env, LAVISH_AXI_STATE_DIR: path.join(alias, 'lavish') };
  await success(run(['--input-type=module', '-e', `import {ensureRelay} from ${JSON.stringify(relay)}; await ensureRelay(${JSON.stringify(first)});`], aliasEnv));
  const owner = await readFile(path.join(x.daemonDir, 'daemon.lock', 'pid'), 'utf8');
  await mkdir(x.env.LAVISH_AXI_STATE_DIR);
  await success(x.launch(second));
  assert.equal(await readFile(path.join(relayPaths(first).lock, 'pid'), 'utf8'), owner);
  assert.equal(await readFile(path.join(relayPaths(second).lock, 'pid'), 'utf8'), owner);
});

test('registration contends safely with idle shutdown', { timeout: 45000 }, async t => {
  const x = await setup(t), first = await x.page('first'), second = await x.page('second'); await x.list([first]);
  await success(x.launch(first));
  const release = await claimLock(path.join(x.daemonDir, 'start.lock'), { wait: true });
  let pending;
  try {
    await x.list([]); await until(async () => !await exists(relayPaths(first).lock));
    await new Promise(resolve => setTimeout(resolve, 1300));
    await x.list([second]); pending = x.launch(second);
  } finally { await release(); }
  await success(pending);
  const owner = await readFile(path.join(x.daemonDir, 'daemon.lock', 'pid'), 'utf8');
  assert.equal(await readFile(path.join(relayPaths(second).lock, 'pid'), 'utf8'), owner);
});

test('an owned daemon crash is recovered on the next registration', { timeout: 45000 }, async t => {
  const x = await setup(t), file = await x.page('page'); await x.list([file]);
  const daemon = spawn(process.execPath, [worker, '--daemon'], { env: x.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(daemon, 'exit');
  try {
    const [message] = await once(daemon, 'message'); assert.equal(message.running, true);
    await success(x.launch(file));
    assert.equal(Number(await readFile(path.join(relayPaths(file).lock, 'pid'), 'utf8')), daemon.pid);
    daemon.kill('SIGKILL'); const [, signal] = await exited; assert.equal(signal, 'SIGKILL');
  } finally { if (daemon.exitCode === null && daemon.signalCode === null) { daemon.kill('SIGKILL'); await exited; } }
  await success(x.launch(file));
  const owner = await readFile(path.join(x.daemonDir, 'daemon.lock', 'pid'), 'utf8');
  assert.notEqual(Number(owner), daemon.pid);
  assert.equal(await readFile(path.join(relayPaths(file).lock, 'pid'), 'utf8'), owner);
});
