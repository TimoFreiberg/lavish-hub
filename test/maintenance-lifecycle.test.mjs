import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/maintenance.mjs', import.meta.url));
test('claims serialize workers, blocked workers must reclaim, and launches reconcile by name', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'maintenance-life-'));
  const bin = path.join(dir, 'bin'); mkdirSync(bin);
  const listing = path.join(dir, 'terminals.json');
  writeFileSync(path.join(bin, 'hc'), '#!/bin/sh\nif [ "$1" = ls ]; then cat "$FAKE_TERMINALS"; else exit 1; fi\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: dir, MAINTENANCE_REPO: 'owner/project', FAKE_TERMINALS: listing };
  const stateDir = path.join(dir, 'lavish-kit', 'maintenance', 'owner--project'); mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'state.json');
  const state = () => JSON.parse(readFileSync(file));
  const run = (terminal, ...args) => spawnSync(process.execPath, [script, ...args], { env: { ...env, HC_TERMINAL_ID: terminal }, encoding: 'utf8' });
  try {
    writeFileSync(file, JSON.stringify({ jobs: [{ id: 'a', status: 'running', terminal: 'a' }, { id: 'b', status: 'blocked', terminal: 'b' }], etags: {}, cache: {}, reviewed: {} }));
    const first = run('a', 'claim', 'a'); assert.equal(first.status, 0, first.stderr); const token = first.stdout.trim();
    assert.notEqual(run('b', 'claim', 'b').status, 0);
    assert.notEqual(run('b', 'outcome', 'a', token, 'blocked').status, 0);
    assert.equal(run('a', 'outcome', 'a', token, 'blocked').status, 0);
    const second = run('b', 'claim', 'b'); assert.equal(second.status, 0, second.stderr);
    assert.notEqual(run('a', 'claim', 'a').status, 0);
    assert.notEqual(run('a', 'retry', 'a').status, 0);
    assert.equal(run('b', 'outcome', 'b', second.stdout.trim(), 'failed').status, 0);
    assert.equal(run('b', 'retry', 'b').status, 0);
    assert.equal(run('a', 'claim', 'a').status, 0);
    const s = state(); s.jobs = [{ id: 'c', status: 'launching', name: 'maint-c' }]; writeFileSync(file, JSON.stringify(s));
    writeFileSync(listing, JSON.stringify({ terminals: [] }));
    assert.equal(run('a', 'reconcile').status, 0); assert.equal(state().jobs[0].status, 'uncertain');
    assert.notEqual(run('a', 'retry', 'c').status, 0);
    writeFileSync(listing, JSON.stringify({ terminals: [{ name: 'maint-c', address: 'c', state: 'live' }] }));
    assert.equal(run('a', 'reconcile').status, 0); assert.equal(state().jobs[0].status, 'running');
    assert.equal(state().jobs[0].terminal, 'c');
    writeFileSync(listing, JSON.stringify({ terminals: [{ name: 'maint-c', address: 'c', state: 'dead' }] }));
    assert.equal(run('a', 'reconcile').status, 0); assert.equal(state().jobs[0].status, 'failed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
