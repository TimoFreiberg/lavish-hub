import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/maintenance.mjs', import.meta.url));
test('status, retry and launch preconditions use local state', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'maintenance-test-'));
  const env = { ...process.env, XDG_STATE_HOME: dir, MAINTENANCE_REPO: 'owner/project' };
  delete env.HC_TERMINAL_ID;
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
  try {
    assert.equal(run('--help').status, 0);
    assert.equal(run('status').status, 0);
    assert.match(run('once').stderr, /HC_TERMINAL_ID is missing/);
    const stateDir = path.join(dir, 'lavish-hub', 'maintenance', 'owner--project');
    const stateFile = path.join(stateDir, 'state.json');
    writeFileSync(stateFile, JSON.stringify({ jobs: [{ id: 'one', status: 'failed' }] }));
    assert.equal(run('retry', 'one').status, 0);
    assert.equal(JSON.parse(readFileSync(stateFile)).jobs[0].status, 'queued');
    assert.notEqual(run('retry', 'one').status, 0);
    mkdirSync(path.join(stateDir, 'lock'));
    assert.match(run('status').stderr, /state locked/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
