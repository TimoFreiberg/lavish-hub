import test from 'node:test';
import assert from 'node:assert/strict';
import { runChecks } from '../scripts/check.mjs';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function waitFor(predicate) {
  const deadline = Date.now() + 10000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for child');
    await delay(20);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  for (const interrupted of ['shots', 'test']) {
    test(`correctness command cancels all stages on ${signal} during ${interrupted}`, { timeout: 15000 }, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'lavish-check-signal-'));
      let child;
      try {
        await mkdir(path.join(root, 'scripts'));
        await mkdir(path.join(root, 'bin'));
        await copyFile(new URL('../scripts/check.mjs', import.meta.url), path.join(root, 'scripts/check.mjs'));
        await writeFile(path.join(root, 'bin/npm'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
        await writeFile(path.join(root, 'scripts/test-run.mjs'), `
import { appendFile, access } from 'node:fs/promises';
const name = process.argv[2];
await appendFile('events', name + ':start\\n');
if (${JSON.stringify(interrupted)} === 'test' && name === 'shots') process.exit(0);
const keepAlive = setInterval(() => {}, 1000);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  await appendFile('events', name + ':signal\\n');
  await new Promise(resolve => setTimeout(resolve, 150));
  await access('.checks/lock');
  await appendFile('events', name + ':cleanup\\n');
  clearInterval(keepAlive);
  process.exitCode = 0;
});
await appendFile('events', name + ':ready\\n');
`);
        let output = '';
        child = spawn(process.execPath, ['scripts/check.mjs'], { cwd: root, env: { ...process.env, PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', data => { output += data; });
        child.stderr.on('data', data => { output += data; });
        const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
        const events = async () => readFile(path.join(root, 'events'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
        await waitFor(async () => {
          const text = await events();
          return text.includes(`${interrupted}:ready`) && (interrupted !== 'test' || text.includes('e2e:ready'));
        });
        child.kill(signal);
        const exit = await exited;
        assert.equal(exit.signal, null, output);
        assert.equal(exit.code, 1, output);
        const text = await events();
        const stages = interrupted === 'shots' ? ['shots'] : ['test', 'e2e'];
        for (const stage of stages) {
          assert.ok(text.includes(`${stage}:signal`), text);
          assert.ok(text.includes(`${stage}:cleanup`), text);
        }
        if (interrupted === 'shots') {
          assert.equal(text.includes('test:start'), false, text);
          assert.equal(text.includes('e2e:start'), false, text);
        }
        const directory = output.match(/Correctness artifacts: (.+)/)[1];
        const status = JSON.parse(await readFile(path.join(directory, 'status.json'), 'utf8'));
        assert.equal(status.status, 'failed');
        for (const stage of stages) assert.notEqual(status.stages[stage].code, 0);
        await assert.rejects(readFile(path.join(root, '.checks/lock/owner.json')), { code: 'ENOENT' });
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

for (const failing of [undefined, 'install', 'shots', 'test', 'e2e']) {
  test(`correctness pipeline preserves ordering and propagates ${failing || 'no'} failure`, async () => {
    const events = [], snapshots = new Map(); let active = 0, maximum = 0;
    const result = await runChecks({
      directory: '<artifacts>',
      publish: async (name, value) => { snapshots.set(name, structuredClone(value)); events.push(name); },
      execute: async name => {
        events.push(name);
        if (['test', 'e2e'].includes(name)) {
          assert.ok(snapshots.has('screenshots-ready.json'));
          active++; maximum = Math.max(maximum, active);
          await new Promise(resolve => setImmediate(resolve)); active--;
        }
        return name === failing ? 7 : 0;
      },
    });
    assert.equal(result.status, failing ? 'failed' : 'passed');
    assert.equal(events[1], 'install');
    if (failing === 'install') {
      assert.equal(events.includes('shots'), false); assert.equal(snapshots.has('screenshots-ready.json'), false);
    } else {
      assert.ok(events.indexOf('shots') < events.indexOf('test'));
      assert.equal(maximum, 2);
      assert.equal(snapshots.get('screenshots-ready.json').status, failing === 'shots' ? 'failed' : 'passed');
      assert.deepEqual(Object.keys(result.stages).sort(), ['e2e', 'install', 'shots', 'test']);
    }
    assert.equal(snapshots.get('status.json').status, result.status);
    assert.equal(result.screenshotReviewRequired, true);
  });
}

for (const boundary of ['before checks', 'after install', 'after shots']) {
  test(`correctness pipeline remembers cancellation ${boundary}`, async () => {
    const controller = new AbortController(), started = [];
    if (boundary === 'before checks') controller.abort();
    const result = await runChecks({
      directory: '<artifacts>', signal: controller.signal,
      execute: async name => { started.push(name); return 0; },
      publish: async (name, value) => {
        if ((boundary === 'after install' && name === 'status.json' && value.stages.install)
          || (boundary === 'after shots' && name === 'screenshots-ready.json')) controller.abort();
      },
    });
    assert.equal(result.status, 'failed');
    assert.deepEqual(started, boundary === 'before checks' ? [] : boundary === 'after install' ? ['install'] : ['install', 'shots']);
  });
}

test('correctness pipeline records stage exceptions and completes other checks', async () => {
  const result = await runChecks({ directory: '<artifacts>', publish: async () => {}, execute: async name => { if (name === 'test') throw new Error('launch failed'); return 0; } });
  assert.equal(result.status, 'failed'); assert.equal(result.stages.test.error, 'launch failed'); assert.equal(result.stages.e2e.code, 0);
});
