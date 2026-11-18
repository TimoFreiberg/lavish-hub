import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createHubJj, readHubSnapshot } from '../src/hub-jj.mjs';

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

test('hub detects a concurrent rewrite after the check instead of claiming success', async t => {
  const cwd = await repo(t);
  const jj = createHubJj(cwd, { beforeDescribe: async () => { run(cwd, 'jj', 'describe', '-m', 'external'); } });
  const row = (await jj.snapshot()).commits[0];
  const result = await jj.describe(request(row, 'ours'));
  assert.notEqual(result.status, 'saved');
});
