import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHubDocuments, readMetadata } from '../src/hub-documents.mjs';
import { parseArgs } from '../src/cli.mjs';

test('hub registrations persist, replace metadata, and protect save targets', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-documents-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = path.join(dir, 'a.md'), b = path.join(dir, 'b.md');
  await writeFile(a, '- [ ] one\n'); await writeFile(b, '- [x] two\n');
  let store = await createHubDocuments(path.join(dir, 'state'));
  const first = await store.publish({ id: 'review', file: a, metadata: { reviewedRepository: 'Example', headCommit: 'a'.repeat(40) }, attention: true });
  store = await createHubDocuments(path.join(dir, 'state'));
  assert.equal(store.list().documents[0].metadata.reviewedRepository, 'Example');
  assert.equal(store.list().documents[0].attention, true);
  assert.equal(store.list().documents[0].viewedVersion, null);
  assert.ok(Date.parse(store.list().documents[0].publishedAt) > 0);
  // Plain republish preserves an unacknowledged attention flag.
  const republished = await store.publish({ id: 'review', file: b });
  assert.deepEqual(store.list().documents[0].metadata, {});
  assert.equal(store.list().documents[0].attention, true);
  assert.equal(store.list().documents[0].viewedVersion, null);
  // Acknowledging a stale version must not clear the current version's flags.
  assert.equal(await store.acknowledge({ id: 'review', version: first.version }), false);
  assert.equal(store.list().documents[0].attention, true);
  // Acknowledging the current version marks it viewed and clears attention.
  assert.equal(await store.acknowledge({ id: 'review', version: republished.version }), true);
  assert.equal(store.list().documents[0].attention, false);
  assert.equal(store.list().documents[0].viewedVersion, republished.version);
  assert.equal(await store.acknowledge({ id: 'review', version: republished.version }), false);
  // A subsequent plain republish marks the new version unseen without re-raising attention.
  const third = await store.publish({ id: 'review', file: b });
  assert.equal(store.list().documents[0].attention, false);
  assert.equal(store.list().documents[0].viewedVersion, republished.version);
  assert.notEqual(store.list().documents[0].viewedVersion, third.version);
  await store.attach({ kind: 'tasks', file: a });
  const previous = await store.read({ id: 'tasks' });
  await store.attach({ kind: 'tasks', file: b });
  await assert.rejects(store.save({ id: 'tasks', version: previous.version, baseHash: previous.hash, text: 'wrong' }), /target changed/);
  assert.equal(await readFile(b, 'utf8'), '- [x] two\n');
  const current = await store.read({ id: 'tasks' });
  assert.equal((await store.save({ id: 'tasks', version: current.version, baseHash: current.hash, text: '- [ ] changed\n' })).reply, 'Saved');
  await writeFile(b, 'external');
  assert.match((await store.save({ id: 'tasks', version: current.version, baseHash: current.hash, text: 'draft' })).reply, /Conflict/);
  assert.equal(await readFile(b, 'utf8'), 'external');
});

test('obsolete attachments are ignored without affecting tasks or published documents', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-old-attachments-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tasks = path.join(dir, 'tasks-source.md');
  await writeFile(tasks, 'tasks');
  await writeFile(path.join(dir, 'documents.json'), JSON.stringify({ documents: {}, attachments: { tasks: { source: tasks, version: 'task-version' }, pr: { source: path.join(dir, 'missing.md'), version: 'old' } } }));
  const store = await createHubDocuments(dir);
  assert.deepEqual(Object.keys(store.list().attachments), ['tasks']);
  assert.equal((await store.read({ id: 'tasks' })).text, 'tasks');
  await assert.rejects(store.read({ id: 'pr' }), /Unknown document/);
  await assert.rejects(store.attach({ kind: 'pr', file: tasks }), /Invalid attachment/);
  await store.publish({ id: 'pr', file: tasks });
  assert.equal((await store.read({ id: 'pr' })).text, 'tasks');
  assert.throws(() => parseArgs(['hub', 'pr', '--file', tasks]), /unknown hub command/);
});

test('hub metadata validation and CLI options', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-metadata-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'metadata.json');
  await writeFile(file, JSON.stringify({ sourceUrl: 'file:///tmp/no' }));
  await assert.rejects(readMetadata(file), /source URL/);
  await writeFile(file, JSON.stringify({ unexpected: 'x' }));
  await assert.rejects(readMetadata(file), /metadata field/);
  await writeFile(file, JSON.stringify({ reviewedRepository: 'x'.repeat(17000) }));
  await assert.rejects(readMetadata(file), /16 KiB/);
  assert.deepEqual(parseArgs(['hub', 'publish', 'review.md', '--id', 'review', '--metadata-file', 'meta.json']), { hub: 'publish', file: 'review.md', id: 'review', metadataFile: 'meta.json' });
  assert.deepEqual(parseArgs(['hub', 'publish', 'review.md', '--id', 'review', '--attention']), { hub: 'publish', file: 'review.md', id: 'review', attention: true });
  assert.throws(() => parseArgs(['hub', 'publish', 'review.md', '--id', 'review', '--attention', '--attention']), /given twice/);
  assert.throws(() => parseArgs(['hub', 'publish', 'review.md']), /requires --id/);
});
