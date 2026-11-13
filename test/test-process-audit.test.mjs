import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { markedProcesses } from '../scripts/test-process-audit.mjs';

test('process audit detects a detached child with the run marker', async () => {
  const marker = randomUUID();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: 'ignore', env: { ...process.env, LAVISH_KIT_TEST_RUN: marker },
  });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  try {
    assert.ok(markedProcesses(marker).includes(child.pid));
    assert.deepEqual(markedProcesses(randomUUID()), []);
  } finally {
    child.kill();
    await exited;
  }
  assert.ok(!markedProcesses(marker).includes(child.pid));
});
