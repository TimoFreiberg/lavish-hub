import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHubDocuments, deriveDocumentId, readMetadata, isDocumentCollapsed, OLD_ARTIFACT_MS } from '../src/hub-documents.mjs';
import { createHash } from 'node:crypto';
import { parseArgs } from '../src/cli.mjs';

test('collapse classification respects unread state, stack, age and overrides', () => {
  const now = Date.now(), old = new Date(now - OLD_ARTIFACT_MS).toISOString();
  const doc = { version: 'v', viewedVersion: 'v', publishedAt: old, metadata: { headCommit: 'head' } };
  const options = { repoName: 'repo', now, stackCommitIds: new Set(['head']) };
  assert.equal(isDocumentCollapsed(doc, options), false);
  assert.equal(isDocumentCollapsed(doc, { ...options, stackCommitIds: new Set() }), true);
  assert.equal(isDocumentCollapsed(doc, { ...options, stackCommitIds: null }), false);
  assert.equal(isDocumentCollapsed({ ...doc, viewedVersion: null }, { ...options, stackCommitIds: new Set() }), false);
  for (const metadata of [{}, { headCommit: 'head', sourceUrl: 'https://example.invalid/' }, { headCommit: 'head', reviewedRepository: 'other' }]) {
    assert.equal(isDocumentCollapsed({ ...doc, metadata }, options), true);
    assert.equal(isDocumentCollapsed({ ...doc, metadata, publishedAt: new Date(now - OLD_ARTIFACT_MS + 1).toISOString() }, options), false);
    assert.equal(isDocumentCollapsed({ ...doc, metadata, viewedVersion: null }, options), false);
  }
  assert.equal(isDocumentCollapsed({ ...doc, sidebarOverride: { version: 'v', collapsed: true }, viewedVersion: null }, options), true);
  assert.equal(isDocumentCollapsed({ ...doc, sidebarOverride: { version: 'v', collapsed: false } }, { ...options, stackCommitIds: new Set() }), false);
});

test('collapse override persists without acknowledging and resets on republish', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-collapse-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'review.md');
  await writeFile(file, 'review');
  let store = await createHubDocuments(path.join(dir, 'state'));
  const doc = await store.publish({ id: 'review', file });
  assert.equal(await store.setCollapsed({ id: doc.id, version: doc.version, collapsed: true }), true);
  assert.equal(await store.setCollapsed({ id: doc.id, version: doc.version, collapsed: true }), false);
  await assert.rejects(store.setCollapsed({ id: doc.id, version: 'stale', collapsed: false }), /changed/);
  store = await createHubDocuments(path.join(dir, 'state'));
  assert.deepEqual(store.list().documents[0].sidebarOverride, { version: doc.version, collapsed: true });
  assert.equal(store.list().documents[0].viewedVersion, null);
  await store.publish({ id: doc.id, file });
  assert.equal(store.list().documents[0].sidebarOverride, undefined);
  assert.equal(store.list().documents[0].viewedVersion, null);
});

test('malformed legacy sidebar overrides are discarded on load', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const values = [null, [], 'hidden', {}, { version: 1, collapsed: true }, { version: 'v', collapsed: 'true' }];
  const documents = Object.fromEntries(values.map((value, i) => [String(i), { id: String(i), version: 'v', sidebarOverride: value }]));
  documents.valid = { id: 'valid', version: 'v', sidebarOverride: { version: 'v', collapsed: true } };
  await writeFile(path.join(dir, 'documents.json'), JSON.stringify({ documents, attachments: {} }));
  const loaded = (await createHubDocuments(dir)).list().documents;
  for (const doc of loaded.filter(doc => doc.id !== 'valid')) assert.equal(Object.hasOwn(doc, 'sidebarOverride'), false);
  assert.deepEqual(loaded.find(doc => doc.id === 'valid').sidebarOverride, { version: 'v', collapsed: true });
});

test('derived document IDs avoid collisions and fit document ID rules', async t => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hub-ids-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = path.join(dir, 'one', 'Review.html'), second = path.join(dir, 'two', 'Review.html');
  const hash = createHash('sha256').update(second).digest('hex').slice(0, 8);
  assert.equal(deriveDocumentId(first, {}), 'review');
  assert.equal(deriveDocumentId(first, { review: { source: first } }), 'review');
  assert.equal(deriveDocumentId(second, { review: { source: first } }), `review-${hash}`);
  assert.throws(() => deriveDocumentId(second, { review: { source: first }, [`review-${hash}`]: { source: first } }), /already used/);
  for (const id of ['diff', 'tasks']) assert.equal(deriveDocumentId(path.join(dir, `${id}.html`), {}), `${id}-doc`);
  for (const id of ['commits', 'changes']) assert.equal(deriveDocumentId(path.join(dir, `${id}.html`), {}), id);
  assert.equal(deriveDocumentId(path.join(dir, ' --_ !!.html'), {}), 'doc-');
  assert.equal(deriveDocumentId(path.join(dir, '  Hello, World!.html'), {}), 'hello-world');
  const long = path.join(dir, `${'a'.repeat(80)}.html`);
  assert.equal(deriveDocumentId(long, {}).length, 64);
  assert.match(deriveDocumentId(long, { ['a'.repeat(64)]: { source: first } }), /^a{55}-[0-9a-f]{8}$/);
  await Promise.all([mkdir(path.dirname(first)), mkdir(path.dirname(second))]);
  await writeFile(first, '<p>one</p>'); await writeFile(second, '<p>two</p>');
  const store = await createHubDocuments(path.join(dir, 'state'));
  let generatedId;
  await store.publish({ file: first }, async (_docs, commit, id) => { generatedId = id; await commit(); });
  assert.equal(generatedId, 'review');
  assert.equal((await store.publish({ file: first })).id, 'review');
  assert.equal((await store.publish({ file: second })).id, `review-${hash}`);
  assert.equal(store.list().documents.length, 2);
});

test('republishing a source reuses its explicit ID', async t => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hub-republish-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'review.html');
  await writeFile(file, '<p>review</p>');
  const store = await createHubDocuments(path.join(dir, 'state'));
  await store.publish({ id: 'custom', file });
  assert.equal((await store.publish({ file })).id, 'custom');
  assert.equal(store.list().documents.length, 1);
  await assert.rejects(store.publish({ file: path.join(dir, 'missing.html') }), { code: 'VALIDATION_ERROR', action: 'fix_args' });
});

test('hub registrations persist, replace metadata, and protect save targets', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-documents-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = path.join(dir, 'a.md'), b = path.join(dir, 'b.md');
  await writeFile(a, '- [ ] one\n'); await writeFile(b, '- [x] two\n');
  let store = await createHubDocuments(path.join(dir, 'state'));
  const first = await store.publish({ id: 'review', file: a, metadata: { reviewedRepository: 'Example', headCommit: 'a'.repeat(40) } });
  store = await createHubDocuments(path.join(dir, 'state'));
  assert.equal(store.list().documents[0].metadata.reviewedRepository, 'Example');
  assert.equal(Object.hasOwn(store.list().documents[0], 'attention'), false);
  assert.equal(store.list().documents[0].viewedVersion, null);
  assert.ok(Date.parse(store.list().documents[0].publishedAt) > 0);
  const republished = await store.publish({ id: 'review', file: b });
  assert.deepEqual(store.list().documents[0].metadata, {});
  assert.equal(store.list().documents[0].viewedVersion, null);
  assert.equal(await store.acknowledge({ id: 'review', version: first.version }), false);
  assert.equal(await store.acknowledge({ id: 'review', version: republished.version }), true);
  assert.equal(store.list().documents[0].viewedVersion, republished.version);
  assert.equal(await store.acknowledge({ id: 'review', version: republished.version }), false);
  const third = await store.publish({ id: 'review', file: b });
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

test('legacy attention documents load and are omitted from subsequent writes', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-legacy-documents-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'review.md');
  await writeFile(source, 'review');
  await writeFile(path.join(dir, 'documents.json'), JSON.stringify({ documents: { review: { id: 'review', title: 'Review', source, version: 'v1', viewedVersion: null, attention: true } }, attachments: {} }));
  const store = await createHubDocuments(dir);
  assert.equal(Object.hasOwn(store.list().documents[0], 'attention'), false);
  assert.equal(await store.acknowledge({ id: 'review', version: 'v1' }), true);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(path.join(dir, 'documents.json'), 'utf8')).documents.review, 'attention'), false);
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
  assert.throws(() => parseArgs(['pr', '--file', tasks]), /unknown command/);
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
  assert.deepEqual(parseArgs(['publish', 'review.md', '--id', 'review', '--metadata-file', 'meta.json']), { hub: 'publish', file: 'review.md', id: 'review', metadataFile: 'meta.json' });
  assert.throws(() => parseArgs(['publish', 'review.md', '--attention']), /unknown argument --attention/);
  assert.deepEqual(parseArgs(['publish', 'review.md']), { hub: 'publish', file: 'review.md' });
});
