import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/maintenance.mjs', import.meta.url));
const commit = 'a'.repeat(40);
test('issue finalization survives remote effects and rejects newer activity', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'maintenance-final-'));
  const bin = path.join(dir, 'bin'); mkdirSync(bin);
  const remote = path.join(dir, 'remote.json');
  const stateDir = path.join(dir, 'lavish-kit', 'maintenance', 'owner--project'); mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, 'state.json');
  const issue = { number: 1, state: 'open', title: 'Request', body: 'Details', user: { login: 'operator' } };
  const fingerprint = createHash('sha256').update(JSON.stringify([{ id: 'issue', title: issue.title, body: issue.body }])).digest('hex');
  writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const file = process.env.FAKE_REMOTE, r = JSON.parse(fs.readFileSync(file));
const a = process.argv.slice(2), endpoint = a.find(x => x.startsWith('repos/'));
const method = a.includes('--method') ? a[a.indexOf('--method') + 1] : 'GET';
if (method === 'POST') { r.comments.push({ id: r.comments.length + 1, user: { login: 'operator' }, body: a[a.indexOf('-f') + 1].slice(5) }); }
if (method === 'PATCH') r.issue.state = 'closed';
if (method !== 'GET') { fs.writeFileSync(file, JSON.stringify(r)); if (r.fail === method) process.exit(1); process.stdout.write('{}'); process.exit(0); }
let result = endpoint.includes('/compare/') ? { status: r.reachable ? 'ahead' : 'diverged' } : endpoint.includes('/comments?') ? r.comments : r.issue;
process.stdout.write('HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n' + JSON.stringify(result));
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: dir, MAINTENANCE_REPO: 'owner/project', MAINTENANCE_OPERATOR: 'operator', HC_TERMINAL_ID: 'terminal', FAKE_REMOTE: remote };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
  const getRemote = () => JSON.parse(readFileSync(remote));
  const setRemote = r => writeFileSync(remote, JSON.stringify(r));
  const state = () => JSON.parse(readFileSync(stateFile));
  const reset = () => { setRemote({ issue: { ...issue }, comments: [], reachable: false }); writeFileSync(stateFile, JSON.stringify({ jobs: [{ id: 'job', kind: 'issue', status: 'running', details: { number: 1, fingerprint }, claim: { token: 'token', terminal: 'terminal' } }], etags: {}, cache: {}, reviewed: {} })); };
  const call = (...args) => run(...args, 'job', 'token');
  try {
    reset();
    assert.equal(run('finalization-intent', 'job', 'token', 'fix', commit).status, 0);
    assert.notEqual(call('finalize').status, 0);
    assert.equal(state().jobs[0].finalization.value, commit);
    let r = getRemote(); r.reachable = true; r.fail = 'POST'; setRemote(r);
    assert.notEqual(call('finalize').status, 0);
    assert.equal(getRemote().comments.length, 1);
    assert.ok(state().jobs[0].finalization.pushConfirmed);
    r = getRemote(); r.issue.body = 'New requirements'; delete r.fail; setRemote(r);
    assert.notEqual(call('finalize').status, 0);
    assert.equal(getRemote().issue.state, 'open');
    assert.equal(getRemote().comments.length, 1);
    r = getRemote(); r.issue.body = issue.body; r.fail = 'PATCH'; setRemote(r);
    assert.notEqual(call('finalize').status, 0);
    assert.equal(getRemote().comments.length, 1);
    assert.equal(getRemote().issue.state, 'closed');
    assert.ok(state().jobs[0].finalization.closeIntent);
    r = getRemote(); delete r.fail; setRemote(r);
    assert.equal(call('finalize').status, 0);
    assert.equal(getRemote().comments.length, 1);
    assert.match(getRemote().comments[0].body, new RegExp(`https://github.com/owner/project/commit/${commit}`));
    assert.equal(run('outcome', 'job', 'token', 'completed').status, 0);
    reset();
    assert.equal(run('finalization-intent', 'job', 'token', 'evidence', 'Already fixed by a verified change').status, 0);
    r = getRemote(); r.issue.body = 'New requirements'; setRemote(r);
    assert.notEqual(call('finalize').status, 0);
    assert.equal(getRemote().comments.length, 0);
    assert.equal(getRemote().issue.state, 'open');
    r.issue.body = issue.body; setRemote(r);
    assert.equal(call('finalize').status, 0);
    assert.match(getRemote().comments[0].body, /Already fixed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
