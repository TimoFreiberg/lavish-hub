import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTitleResolver, createPolytokenTitleProvider, discoverAncestorPids, parseProcStatPpid, parsePsSnapshot } from '../src/hub-title.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-title-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const put = async (id, record) => {
    await mkdir(path.join(dir, id), { recursive: true });
    await writeFile(path.join(dir, id, 'record.json'), typeof record === 'string' ? record : JSON.stringify(record));
  };
  return { dir, put };
}

test('provider chain isolates errors, honors order, and validates results', async () => {
  const calls = [];
  const resolver = createTitleResolver({ providers: [
    { resolve() { calls.push(1); throw Error('unavailable'); } },
    { resolve() { calls.push(2); return '  title  '; } },
    { resolve() { calls.push(3); return 'later'; } },
  ] });
  assert.equal(await resolver.resolve(), 'title');
  assert.deepEqual(calls, [1, 2]);
  assert.equal(await createTitleResolver({ providers: [{ resolve: () => 'x'.repeat(241) }, { resolve: () => 'later' }] }).resolve(), null);
});

test('direct IDs are safe, and cached records update and rescan after removal', async t => {
  const { dir, put } = await fixture(t);
  await put('direct', { session_title: 'First' });
  await put('other', { pid: 42, session_title: 'Fallback' });
  let count = 0;
  const provider = createPolytokenTitleProvider({ sessionsDir: dir, env: {}, getAncestorPids: () => { count++; return [42]; } });
  assert.equal(await provider.resolve({ session: 'direct' }), 'First');
  await put('direct', { session_title: 'Second' });
  assert.equal(await provider.resolve({ session: 'direct' }), 'Second');
  await rm(path.join(dir, 'direct'), { recursive: true });
  assert.equal(await provider.resolve({ session: 'direct' }), 'Fallback');
  assert.equal(count, 1);
  const unsafe = createPolytokenTitleProvider({ sessionsDir: dir, env: {}, getAncestorPids: () => [] });
  assert.equal(await unsafe.resolve({ session: '../other' }), null);
});

test('ancestor discovery is memoized even with no match or an error', async t => {
  const { dir, put } = await fixture(t);
  let count = 0;
  const provider = createPolytokenTitleProvider({ sessionsDir: dir, env: {}, getAncestorPids: () => { count++; return [42]; } });
  assert.equal(await provider.resolve(), null);
  assert.equal(await provider.resolve(), null);
  await put('a', { pid: 42, session_title: 'Found' });
  assert.equal(await provider.resolve(), 'Found');
  assert.equal(count, 1);
  const failing = createPolytokenTitleProvider({ sessionsDir: dir, env: {}, getAncestorPids: () => { throw Error('ps'); } });
  assert.equal(await failing.resolve(), null);
});

test('project path wins, then closest ancestor, then newest start', async t => {
  const { dir, put } = await fixture(t);
  await put('distant', { pid: 3, session_title: 'Distant', project_path: dir, started_at: '2025-01-01' });
  await put('other', { pid: 2, session_title: 'Other', project_path: '/not-a-project', started_at: '2025-01-01' });
  await put('old', { pid: 2, session_title: 'Old', project_path: dir, started_at: '2023-01-01' });
  await put('new', { pid: 2, session_title: 'New', project_path: dir, started_at: '2024-01-01' });
  const provider = createPolytokenTitleProvider({ sessionsDir: dir, env: {}, getAncestorPids: () => [2, 3] });
  assert.equal(await provider.resolve({ workspaceRoot: dir }), 'New');
  const stale = createPolytokenTitleProvider({ sessionsDir: dir, env: {}, getAncestorPids: () => [2, 3] });
  await rm(path.join(dir, 'old'), { recursive: true });
  await rm(path.join(dir, 'new'), { recursive: true });
  assert.equal(await stale.resolve({ workspaceRoot: dir }), 'Distant');
});

test('environment session ID is tried after a non-Polytoken context ID', async t => {
  const { dir, put } = await fixture(t);
  await put('polytoken', { session_title: 'Environment title' });
  const provider = createPolytokenTitleProvider({ sessionsDir: dir, env: { POLYTOKEN_SESSION_ID: 'polytoken' }, getAncestorPids: () => [] });
  assert.equal(await provider.resolve({ session: 'different' }), 'Environment title');
});

test('negative scans are cached until the session directory changes', async t => {
  const { dir, put } = await fixture(t);
  await put('existing', { pid: 43, session_title: 'Not a match' });
  const provider = createPolytokenTitleProvider({ sessionsDir: dir, env: {}, getAncestorPids: () => [42] });
  assert.equal(await provider.resolve(), null);
  await put('existing', { pid: 42, session_title: 'Found' });
  assert.equal(await provider.resolve(), null);
  await put('new', { pid: 44 });
  assert.equal(await provider.resolve(), 'Found');
});

test('ancestor discovery excludes PID 1 and includes the host parent', async t => {
  assert.deepEqual(await discoverAncestorPids({ ppid: 1 }), []);
  const ancestors = await discoverAncestorPids({ ppid: process.ppid });
  assert.ok(Array.isArray(ancestors));
  if (process.ppid > 1) assert.ok(ancestors.includes(process.ppid));
  assert.ok(!ancestors.includes(1));
  const { dir, put } = await fixture(t);
  await put('init', { pid: 1, session_title: 'Stale' });
  const provider = createPolytokenTitleProvider({ sessionsDir: dir, env: {}, getAncestorPids: () => [1] });
  assert.equal(await provider.resolve(), null);
});

test('process parsers handle spaces and parentheses and ignore bad rows', () => {
  assert.equal(parseProcStatPpid('123 (a name (with) parens) S 42 5 6'), 42);
  assert.equal(parseProcStatPpid('bad'), null);
  assert.deepEqual([...parsePsSnapshot(' 10 2\ninvalid\n3 1\n')], [[10, 2], [3, 1]]);
});

test('missing directories and malformed records fail open', async t => {
  const { dir, put } = await fixture(t);
  await put('broken', '{');
  const provider = createPolytokenTitleProvider({ sessionsDir: dir, env: {}, getAncestorPids: () => [1] });
  assert.equal(await provider.resolve({ session: 'broken' }), null);
  const missing = createPolytokenTitleProvider({ sessionsDir: path.join(dir, 'missing'), env: {}, getAncestorPids: () => [1] });
  assert.equal(await missing.resolve(), null);
});
