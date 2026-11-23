import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/maintenance.mjs', import.meta.url));
test('maintenance completion requires recorded dispositions and assigned sweep', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'maintenance-results-'));
  const stateDir = path.join(dir, 'lavish-hub', 'maintenance', 'owner--project'); mkdirSync(stateDir, {recursive:true});
  const file = path.join(stateDir, 'state.json');
  const env = {...process.env, XDG_STATE_HOME:dir, MAINTENANCE_REPO:'owner/project', HC_TERMINAL_ID:'worker'};
  const run = (...args) => spawnSync(process.execPath,[script,...args],{env,encoding:'utf8'});
  const state = () => JSON.parse(readFileSync(file));
  try {
    const candidates = ['a','b','c'].map(name=>({name,latest:'2'}));
    writeFileSync(file,JSON.stringify({jobs:[{id:'m',kind:'maintenance',status:'running',terminal:'worker',claim:{token:'token',terminal:'worker'},details:{main:'main',candidates,sweep:false}}],reviewed:{},etags:{},cache:{}}));
    assert.notEqual(run('outcome','m','token','completed').status,0);
    for (const [i,status] of ['reviewed','deferred','failed'].entries()) {
      assert.equal(run('review-result','m','token',candidates[i].name,'2',status,'evidence').status,0);
      if (i<2) assert.notEqual(run('outcome','m','token','completed').status,0);
    }
    assert.equal(run('outcome','m','token','completed').status,0);
    assert.deepEqual(Object.values(state().reviewed).map(x=>x.status),['reviewed','deferred','failed']);
    assert.equal(run('retry-dependency','c').status,0); assert.equal(state().reviewed.c,undefined);
    const s=state(); s.jobs.push({id:'s',kind:'maintenance',status:'running',claim:{token:'token',terminal:'worker'},details:{main:'main',candidates:[],sweep:true}}); writeFileSync(file,JSON.stringify(s));
    assert.notEqual(run('outcome','s','token','completed').status,0); assert.equal(run('sweep-result','s','token').status,0); assert.equal(run('outcome','s','token','completed').status,0);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('draft per-job finalization state fails with migration guidance', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'maintenance-draft-'));
  const stateDir = path.join(dir, 'lavish-hub', 'maintenance', 'owner--project'); mkdirSync(stateDir, { recursive: true });
  try {
    writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ jobs: [{ finalization: { kind: 'evidence' } }] }));
    const r = spawnSync(process.execPath, [script, 'status'], { env: { ...process.env, XDG_STATE_HOME: dir, MAINTENANCE_REPO: 'owner/project' }, encoding: 'utf8' });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /Unsupported draft maintenance state/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('simultaneous subprocess claims reserve only one worker', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'maintenance-race-'));
  const stateDir = path.join(dir, 'lavish-hub', 'maintenance', 'owner--project'); mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'state.json');
  const env = { ...process.env, XDG_STATE_HOME: dir, MAINTENANCE_REPO: 'owner/project', HC_TERMINAL_ID: 'worker' };
  try {
    writeFileSync(file, JSON.stringify({ jobs: ['a', 'b'].map(id => ({ id, status: 'blocked', terminal: 'worker' })), etags: {}, cache: {}, reviewed: {} }));
    const run = id => new Promise((resolve, reject) => { const p = spawn(process.execPath, [script, 'claim', id], { env, stdio: 'ignore' }); p.on('error', reject); p.on('exit', resolve); });
    const results = await Promise.all([run('a'), run('b')]);
    assert.equal(results.filter(code => code === 0).length, 1);
    assert.equal(JSON.parse(readFileSync(file)).jobs.filter(j => j.claim).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('claims serialize workers, blocked workers must reclaim, and launches reconcile by name', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'maintenance-life-'));
  const bin = path.join(dir, 'bin'); mkdirSync(bin);
  const listing = path.join(dir, 'terminals.json');
  writeFileSync(path.join(bin, 'hc'), '#!/bin/sh\nif [ "$1" = ls ]; then cat "$FAKE_TERMINALS"; else exit 1; fi\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: dir, MAINTENANCE_REPO: 'owner/project', FAKE_TERMINALS: listing };
  const stateDir = path.join(dir, 'lavish-hub', 'maintenance', 'owner--project'); mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'state.json');
  const state = () => JSON.parse(readFileSync(file));
  const run = (terminal, ...args) => spawnSync(process.execPath, [script, ...args], { env: { ...env, HC_TERMINAL_ID: terminal }, encoding: 'utf8' });
  try {
    writeFileSync(file, JSON.stringify({ jobs: [{ id: 'a', status: 'running', terminal: 'a' }, { id: 'b', status: 'blocked', terminal: 'b' }], etags: {}, cache: {}, reviewed: {} }));
    assert.notEqual(run('b', 'claim', 'b').status, 0, 'unclaimed running worker reserves slot');
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
