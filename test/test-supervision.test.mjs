import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runSupervised } from '../scripts/test-supervision.mjs';
import { markedProcesses } from '../scripts/test-process-audit.mjs';

async function fixture(source, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'test-supervision-'));
  const file = path.join(root, 'fixture.test.mjs');
  const marker = [process.env.LAVISH_KIT_TEST_RUN, randomUUID()].filter(Boolean).join(',');
  const env = { ...process.env, LAVISH_KIT_TEST_RUN: marker };
  delete env.NODE_TEST_CONTEXT;
  try {
    await writeFile(file, source);
    await run({ root, file, marker, env });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const options = env => ({ env, timeout: 1000, grace: 100 });
const args = file => ['--test', '--test-concurrency=1', file];

async function assertNoProcesses(marker) {
  for (let i = 0; i < 40; i++) {
    if (!markedProcesses(marker).length) return;
    await delay(50);
  }
  assert.deepEqual(markedProcesses(marker), []);
}

test('failed test with a live interval times out and leaves no processes', { timeout: 10000 }, async () => {
  await fixture("import test from 'node:test';\ntest('fails', () => { setInterval(() => {}, 1000); throw Error('expected failure'); });\n", async ({ file, marker, env }) => {
    const result = await runSupervised(args(file), options(env));
    assert.equal(result.code, 1);
    assert.equal(result.timedOut, true);
    assert.ifError(result.error);
    await assertNoProcesses(marker);
  });
});

test('timeout stops detached marked descendants', { timeout: 10000 }, async () => {
  await fixture("import test from 'node:test';\nimport { spawn } from 'node:child_process';\ntest('hangs', () => { spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }).unref(); setInterval(() => {}, 1000); });\n", async ({ file, marker, env }) => {
    const result = await runSupervised(args(file), options(env));
    assert.equal(result.timedOut, true);
    assert.ifError(result.error);
    await assertNoProcesses(marker);
  });
});

test('outer cancellation reaches nested supervised detached descendants', { timeout: 10000 }, async () => {
  const supervisor = new URL('../scripts/test-supervision.mjs', import.meta.url).href;
  const source = `import { runSupervised } from ${JSON.stringify(supervisor)};
const inner = process.env.LAVISH_KIT_TEST_RUN + ',inner';
const code = "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref(); require('node:fs').writeFileSync(process.env.READY,'ready'); setInterval(()=>{},1000)";
await runSupervised(['-e', code], { env: { ...process.env, LAVISH_KIT_TEST_RUN: inner }, timeout: 30000 });`;
  await fixture(source, async ({ root, file, marker, env }) => {
    env.READY = path.join(root, 'ready');
    const controller = new AbortController();
    const running = runSupervised([file], { ...options(env), timeout: 8000, signal: controller.signal });
    try {
      const deadline = Date.now() + 5000;
      while (!await readFile(env.READY, 'utf8').catch(() => '')) {
        assert.ok(Date.now() < deadline, 'nested fixture did not start');
        await delay(20);
      }
      assert.ok(markedProcesses(marker + ',inner').length >= 2);
    } finally { controller.abort(); }
    const result = await running;
    assert.equal(result.cancelled, true);
    assert.ifError(result.error);
    await assertNoProcesses(marker);
  });
});

test('cleanup continues after signal and audit errors and escalates', { timeout: 10000 }, async () => {
  await fixture('', async ({ marker, env }) => {
    const calls = [];
    let scans = 0;
    const result = await runSupervised(['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {
      ...options(env), timeout: 500,
      audit: value => {
        if (++scans === 1) return [99999999, ...markedProcesses(value)];
        throw new Error('audit failed');
      },
      kill: (pid, signal) => {
        calls.push([pid, signal]);
        if (pid === 99999999) throw new Error('signal failed');
        process.kill(pid, signal);
      },
    });
    assert.equal(result.timedOut, true);
    assert.match(result.error.message, /signal failed/);
    assert.match(result.error.message, /audit failed/);
    assert.ok(calls.some(([pid, signal]) => pid > 0 && pid !== 99999999 && signal === 'SIGTERM'));
    assert.ok(calls.some(([pid, signal]) => pid < 0 && signal === 'SIGKILL'));
    await assertNoProcesses(marker);
  });
});

test('cleanup returns when signals cannot stop the child', { timeout: 10000 }, async () => {
  await fixture('', async ({ marker, env }) => {
    let pid;
    try {
      const result = await runSupervised(['-e', 'setInterval(()=>{},1000)'], {
        ...options(env), timeout: 500,
        audit: value => { const pids = markedProcesses(value); pid = pids[0] ?? pid; return pids; },
        kill: () => { throw new Error('signal denied'); },
      });
      assert.equal(result.timedOut, true);
      assert.match(result.error.message, /signal denied/);
      assert.match(result.error.message, /did not exit/);
    } finally {
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    }
    await assertNoProcesses(marker);
  });
});

test('slow legitimate file completes within its deadline', { timeout: 10000 }, async () => {
  await fixture("import test from 'node:test';\ntest('slow', async () => { await new Promise(resolve => setTimeout(resolve, 400)); });\n", async ({ file, marker, env }) => {
    const result = await runSupervised(args(file), { ...options(env), timeout: 5000 });
    assert.equal(result.code, 0);
    assert.equal(result.timedOut, undefined);
    await assertNoProcesses(marker);
  });
});

test('cancellation stops the file and its detached descendant', { timeout: 10000 }, async () => {
  await fixture("import test from 'node:test';\nimport { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\ntest('hangs', () => { spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }).unref(); writeFileSync(process.env.READY, 'ready'); setInterval(() => {}, 1000); });\n", async ({ root, file, marker, env }) => {
    env.READY = path.join(root, 'ready');
    const controller = new AbortController();
    const running = runSupervised(args(file), { ...options(env), timeout: 8000, signal: controller.signal });
    try {
      const deadline = Date.now() + 5000;
      while (!await readFile(env.READY, 'utf8').catch(() => '')) {
        assert.ok(Date.now() < deadline, 'fixture did not start');
        await delay(20);
      }
    } finally { controller.abort(); }
    const result = await running;
    assert.equal(result.cancelled, true);
    assert.ifError(result.error);
    await assertNoProcesses(marker);
  });
});
