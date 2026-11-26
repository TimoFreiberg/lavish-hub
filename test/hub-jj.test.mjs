import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createHubJj, escapeJjString, isWorkingCopyRev, readHubSnapshot, resolveTargetRev } from '../src/hub-jj.mjs';

const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', JJ_USER: 'Test', JJ_EMAIL: 'test@example.invalid' };
const run = (cwd, ...args) => execFileSync(args[0], args.slice(1), { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function repo(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hub-jj-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  run(cwd, 'git', 'init', '-q', '-b', 'main');
  await writeFile(path.join(cwd, 'file'), 'base\n');
  run(cwd, 'git', 'add', 'file'); run(cwd, 'git', 'commit', '-qm', 'base');
  run(cwd, 'jj', 'git', 'init', '--colocate');
  await writeFile(path.join(cwd, 'file'), 'initial change\n');
  return cwd;
}
const request = (row, description) => ({ changeId: row.changeId, commitId: row.commitId, expectedDescription: row.description, description });

test('stackCommits includes head without snapshotting the working copy', async t => {
  const cwd = await repo(t);
  run(cwd, 'jj', 'config', 'set', '--repo', 'revset-aliases."trunk()"', 'main');
  const target = { rev: await resolveTargetRev(cwd, 'main') };
  const jj = createHubJj(cwd, { target });
  const head = run(cwd, 'jj', '--ignore-working-copy', 'log', '-r', 'main', '--no-graph', '-T', 'commit_id');
  const before = run(cwd, 'jj', '--ignore-working-copy', 'op', 'log', '-n', '1', '--no-graph', '-T', 'id');
  const [first, second] = await Promise.all([jj.stackCommits(), jj.stackCommits()]);
  assert.deepEqual(first, new Set([head]));
  assert.strictEqual(first, second);
  assert.equal(run(cwd, 'jj', '--ignore-working-copy', 'op', 'log', '-n', '1', '--no-graph', '-T', 'id'), before);
});

test('stackCommits refreshes after a rewrite without snapshotting pending changes', async t => {
  const cwd = await repo(t);
  run(cwd, 'jj', 'config', 'set', '--repo', 'revset-aliases."trunk()"', 'main');
  run(cwd, 'jj', 'describe', '-m', 'before');
  const jj = createHubJj(cwd);
  const first = await jj.stackCommits();
  run(cwd, 'jj', 'describe', '-m', 'after');
  const head = run(cwd, 'jj', '--ignore-working-copy', 'log', '-r', '@', '--no-graph', '-T', 'commit_id');
  await writeFile(path.join(cwd, 'file'), 'unsnapshotted change\n');
  const before = run(cwd, 'jj', '--ignore-working-copy', 'op', 'log', '-n', '1', '--no-graph', '-T', 'id');
  await new Promise(resolve => setTimeout(resolve, 2100));
  const second = await jj.stackCommits();
  assert.ok(second.has(head));
  assert.notDeepEqual(second, first);
  assert.equal(run(cwd, 'jj', '--ignore-working-copy', 'op', 'log', '-n', '1', '--no-graph', '-T', 'id'), before);
});

test('hub_jj_snapshot pins metadata, endpoints and patch through an external rewrite', async t => {
  const cwd = await repo(t);
  const snapshot = await readHubSnapshot(cwd, { afterMetadata: async () => {
    await writeFile(path.join(cwd, 'file'), 'later rewrite\n');
    run(cwd, 'jj', 'describe', '-m', 'later');
  } });
  assert.match(snapshot.operationId, /^[0-9a-f]{128}$/);
  assert.ok(snapshot.commits.some(commit => commit.commitId === snapshot.head));
  assert.match(snapshot.patch, /\+initial change/);
  assert.doesNotMatch(snapshot.patch, /later rewrite/);
  assert.equal('stat' in snapshot, false);
  assert.match(snapshot.commits.find(commit => commit.commitId === snapshot.head).stat, /file/);
  const next = await readHubSnapshot(cwd);
  assert.match(next.patch, /\+later rewrite/);
  assert.notEqual(next.head, snapshot.head);
});

test('snapshot requests share cached work and refresh after an external rewrite', async t => {
  const cwd = await repo(t), jj = createHubJj(cwd);
  const [first, second] = await Promise.all([jj.snapshot(), jj.snapshot()]);
  assert.strictEqual(first, second);
  assert.strictEqual(await jj.snapshot(), first);
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.ok(first.version);
  assert.deepEqual(await jj.snapshot({ knownVersion: first.version }), { unchanged: true });
  assert.strictEqual(await jj.snapshot(), first, 'reuse the snapshot after checking the operation');
  const forced = await jj.snapshot({ force: true, knownVersion: first.version });
  assert.equal(forced.operationId, first.operationId);
  assert.notEqual(forced.version, first.version);
  assert.strictEqual(await jj.snapshot({ knownVersion: first.version }), forced);
  await writeFile(path.join(cwd, 'file'), 'external rewrite\n');
  run(cwd, 'jj', 'describe', '-m', 'external');
  const refreshed = await jj.snapshot({ force: true });
  assert.notEqual(refreshed.head, first.head);
  assert.match(refreshed.patch, /external rewrite/);
  assert.strictEqual(await jj.snapshot(), refreshed);
  await writeFile(path.join(cwd, 'file'), 'another external rewrite\n');
  await new Promise(resolve => setTimeout(resolve, 2100));
  const automatic = await jj.snapshot();
  assert.match(automatic.patch, /another external rewrite/);
});

test('diff expansion reads only bounded files from the requested pinned snapshot', async t => {
  const cwd = await repo(t), jj = createHubJj(cwd);
  run(cwd, 'jj', 'new', 'main');
  await writeFile(path.join(cwd, 'file'), 'initial change\n');
  run(cwd, 'jj', 'config', 'set', '--repo', 'revset-aliases."trunk()"', 'main');
  const first = await jj.snapshot();
  await writeFile(path.join(cwd, 'file'), 'later rewrite\n');
  const later = await jj.snapshot({ force: true });
  assert.notEqual(first.head, later.head);
  const files = await jj.diffFiles({ operationId: first.operationId, fileIndex: 0 });
  assert.equal(files.oldFile.contents, 'base\n');
  assert.equal(files.newFile.contents, 'initial change\n');
  await assert.rejects(jj.diffFiles({ operationId: first.operationId, fileIndex: -1 }), /unavailable/);
  await assert.rejects(jj.diffFiles({ operationId: 'bad', fileIndex: 0 }), /unavailable/);
  await writeFile(path.join(cwd, 'file'), 'x'.repeat(1024 * 1024 + 1));
  const large = await jj.snapshot({ force: true });
  await assert.rejects(jj.diffFiles({ operationId: large.operationId, fileIndex: 0 }), /too large/);
});

test('retargeting rejects expansion from a stale snapshot at the same operation', async t => {
  const cwd = await repo(t);
  run(cwd, 'jj', 'config', 'set', '--repo', 'revset-aliases."trunk()"', 'main');
  const firstRev = await resolveTargetRev(cwd, '@');
  run(cwd, 'jj', 'new');
  await writeFile(path.join(cwd, 'file'), 'second change\n');
  const secondRev = await resolveTargetRev(cwd, '@');
  const jj = createHubJj(cwd, { target: { rev: firstRev } });
  const first = await jj.snapshot();
  jj.setTarget({ rev: secondRev });
  const second = await jj.snapshot();
  assert.equal(first.operationId, second.operationId);
  assert.notEqual(first.version, second.version);
  await assert.rejects(jj.diffFiles({ operationId: first.operationId, fileIndex: 0, version: first.version }), /unavailable/);
  const files = await jj.diffFiles({ operationId: second.operationId, fileIndex: 0, version: second.version });
  assert.equal(files.newFile.contents, 'second change\n');
});

test('hub_describe_stale_and_literal checks versions and preserves literal descriptions', async t => {
  const cwd = await repo(t), jj = createHubJj(cwd);
  const original = (await jj.snapshot()).commits[0];
  const text = 'literal $(touch nope)\nsecond line\n';
  const saved = await jj.describe(request(original, text));
  assert.equal(saved.status, 'saved'); assert.equal(saved.current.description, text);
  assert.equal((await jj.describe(request(original, 'stale'))).reason, 'stale');
  assert.equal((await jj.describe(request(saved.current, ''))).current.description, '');
  const root = run(cwd, 'jj', 'log', '-r', 'root()', '--no-graph', '-T', 'change_id ++ " " ++ commit_id');
  const [changeId, commitId] = root.split(' ');
  assert.equal((await jj.describe({ changeId, commitId, expectedDescription: '', description: 'no' })).reason, 'immutable');
});

test('hub rejects divergent versions of a change', async t => {
  const cwd = await repo(t), jj = createHubJj(cwd);
  const row = (await jj.snapshot()).commits[0];
  const op = run(cwd, 'jj', 'op', 'log', '-n', '1', '--no-graph', '-T', 'id');
  run(cwd, 'jj', 'describe', '-r', row.commitId, '-m', 'first');
  run(cwd, 'jj', '--at-operation', op, 'describe', '-r', row.commitId, '-m', 'second');
  const result = await jj.describe(request(row, 'ours'));
  assert.equal(result.reason, 'divergent');
  assert.equal(result.current.length, 2);
});

test('hub description actions serialize and do not report a stale competing save as successful', async t => {
  const cwd = await repo(t), jj = createHubJj(cwd);
  const row = (await jj.snapshot()).commits[0];
  const [first, second] = await Promise.all([jj.describe(request(row, 'first')), jj.describe(request(row, 'second'))]);
  assert.equal(first.status, 'saved'); assert.equal(second.reason, 'stale');
});

test('target revset tracks bookmark moves live and change IDs across amends and rebases', async t => {
  const cwd = await repo(t);
  for (const rev of ['@', '@-', 'parents(@)', 'default@', 'foo(@)']) assert.equal(isWorkingCopyRev(rev), true, rev);
  for (const rev of ['name@remote', 'bookmarks(exact:"a@b")', 'bookmarks(exact:"a\\\"@b")']) assert.equal(isWorkingCopyRev(rev), false, rev);
  assert.equal(escapeJjString('a\\b"c'), 'a\\\\b\\"c');
  for (const invalid of [null, '', ' ', 'x\n']) await assert.rejects(resolveTargetRev(cwd, invalid), /Invalid revision/);
  await assert.rejects(resolveTargetRev(cwd, '@', { ignoreWorkingCopy: true }), /Working-copy revisions require a live workspace checkout/);
  await assert.rejects(resolveTargetRev(cwd, 'none()'), /Revision not found/);
  await assert.rejects(resolveTargetRev(cwd, 'all()'), /Revision must resolve to a single commit/);
  run(cwd, 'jj', 'describe', '-m', 'first');
  run(cwd, 'jj', 'bookmark', 'create', 'feature/topic', '-r', '@');
  run(cwd, 'git', 'remote', 'add', 'peer', path.join(cwd, '.git'));
  run(cwd, 'jj', 'git', 'export');
  run(cwd, 'jj', 'git', 'fetch', '--remote', 'peer');
  const bookmark = await resolveTargetRev(cwd, 'feature/topic', { ignoreWorkingCopy: true });
  const remote = await resolveTargetRev(cwd, 'feature/topic@peer', { ignoreWorkingCopy: true });
  assert.equal(bookmark.kind, 'bookmark'); assert.equal(remote.kind, 'remote-bookmark');
  const pinned = await resolveTargetRev(cwd, '@');
  const short = await resolveTargetRev(cwd, pinned.input, { ignoreWorkingCopy: true });
  const full = await resolveTargetRev(cwd, pinned.changeId, { ignoreWorkingCopy: true });
  assert.equal(short.changeId, pinned.changeId); assert.equal(full.input, pinned.input);
  const jj = createHubJj(cwd, { target: { rev: bookmark } });
  const first = await jj.snapshot();
  run(cwd, 'jj', 'describe', '-r', '@', '-m', 'amended');
  const amended = await readHubSnapshot(cwd, { target: { rev: pinned } });
  assert.notEqual(amended.head, first.head); assert.ok(amended.commits.some(row => row.changeId === pinned.changeId && row.commitId === amended.head));
  run(cwd, 'jj', 'new', '@', '-m', 'second');
  await writeFile(path.join(cwd, 'other'), 'second\n');
  run(cwd, 'jj', 'bookmark', 'set', 'feature/topic', '-r', '@');
  const moved = await jj.snapshot({ force: true });
  assert.notEqual(moved.head, amended.head);
  assert.equal((await readHubSnapshot(cwd, { target: { rev: remote } })).head, first.head);
  run(cwd, 'jj', 'rebase', '-r', `change_id(${pinned.changeId})`, '-d', 'root()');
  const rebased = await readHubSnapshot(cwd, { target: { rev: pinned } });
  assert.ok(rebased.commits.some(row => row.changeId === pinned.changeId && row.commitId === rebased.head));
  assert.notEqual(rebased.head, amended.head);
  const movedAfterRebase = await readHubSnapshot(cwd, { target: { rev: bookmark } });
  run(cwd, 'jj', 'git', 'export');
  run(cwd, 'jj', 'git', 'fetch', '--remote', 'peer');
  assert.equal((await readHubSnapshot(cwd, { target: { rev: remote } })).head, movedAfterRebase.head);
});

test('custom base override scopes stacked commits and non-trunk branches', async t => {
  const cwd = await repo(t);
  run(cwd, 'jj', 'config', 'set', '--repo', 'revset-aliases."trunk()"', 'main');
  run(cwd, 'jj', 'describe', '-m', 'base branch');
  run(cwd, 'jj', 'bookmark', 'create', 'base-branch', '-r', '@');
  run(cwd, 'jj', 'new', '@', '-m', 'stacked');
  await writeFile(path.join(cwd, 'other'), 'stack\n');
  const rev = await resolveTargetRev(cwd, '@');
  const base = await resolveTargetRev(cwd, 'base-branch', { ignoreWorkingCopy: true });
  const normal = await readHubSnapshot(cwd, { target: { rev } });
  const scoped = await readHubSnapshot(cwd, { target: { rev, base } });
  assert.equal(normal.commits.length, 2); assert.equal(scoped.commits.length, 1);
  assert.match(normal.patch, /initial change/); assert.doesNotMatch(scoped.patch, /initial change/);
  assert.match(scoped.patch, /stack/);
  assert.equal(scoped.base, run(cwd, 'jj', 'log', '-r', 'base-branch', '--no-graph', '-T', 'commit_id'));
});

test('describe works on mutable target commits with ignore-working-copy and rejects immutable commits', async t => {
  const cwd = await repo(t);
  run(cwd, 'jj', 'describe', '-m', 'target');
  const rev = await resolveTargetRev(cwd, '@');
  const child = await mkdtemp(path.join(os.tmpdir(), 'hub-jj-child-'));
  t.after(() => rm(child, { recursive: true, force: true }));
  await rm(child, { recursive: true });
  run(cwd, 'jj', 'workspace', 'add', child);
  run(child, 'jj', 'describe', '-r', `change_id(${rev.changeId})`, '-m', 'rewritten elsewhere');
  const binary = execFileSync('which', ['jj'], { encoding: 'utf8' }).trim();
  const stub = await mkdtemp(path.join(os.tmpdir(), 'hub-jj-bin-'));
  t.after(() => rm(stub, { recursive: true, force: true }));
  const marker = path.join(stub, 'calls');
  await writeFile(path.join(stub, 'jj'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${marker}'\nexec '${binary}' "$@"\n`);
  await chmod(path.join(stub, 'jj'), 0o700);
  const search = process.env.PATH;
  process.env.PATH = `${stub}${path.delimiter}${search}`;
  t.after(() => { process.env.PATH = search; });
  const jj = createHubJj(() => cwd, { target: { rev } });
  const first = await jj.snapshot();
  assert.equal(await jj.summary(), 'rewritten elsewhere');
  jj.setTarget({ rev });
  await assert.rejects(jj.diffFiles({ operationId: first.operationId, fileIndex: 0 }), /unavailable/);
  const refreshed = await jj.snapshot();
  assert.notEqual(refreshed.version, first.version); assert.equal(refreshed.operationId, first.operationId);
  const saved = await jj.describe(request(refreshed.commits.find(row => row.changeId === rev.changeId), 'updated'));
  assert.equal(saved.status, 'saved'); assert.equal(await jj.summary(), 'updated');
  const calls = await readFile(marker, 'utf8');
  assert.doesNotMatch(calls, /\bstatus\b/);
  assert.match(calls, /--ignore-working-copy op log/);
  assert.match(calls, /--ignore-working-copy describe -r/);
  assert.match(calls, /--ignore-working-copy log -r/);
  const root = run(cwd, 'jj', 'log', '-r', 'root()', '--no-graph', '-T', 'change_id ++ " " ++ commit_id');
  const [changeId, commitId] = root.split(' ');
  assert.equal((await jj.describe({ changeId, commitId, expectedDescription: '', description: 'no' })).reason, 'immutable');
});

test('hub detects a concurrent rewrite after the check instead of claiming success', async t => {
  const cwd = await repo(t);
  const jj = createHubJj(cwd, { beforeDescribe: async () => { run(cwd, 'jj', 'describe', '-m', 'external'); } });
  const row = (await jj.snapshot()).commits[0];
  const result = await jj.describe(request(row, 'ours'));
  assert.notEqual(result.status, 'saved');
});
