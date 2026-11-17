import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateDemo } from '../scripts/demo.mjs';
import { readHubSnapshot } from '../src/hub-jj.mjs';

test('demo data covers the commit and diff cases and regenerates in place', async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'lavish-kit-demo-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const dir = path.join(parent, 'demo');
  await generateDemo(dir);
  const { repo, head } = await generateDemo(dir);
  const snapshot = await readHubSnapshot(repo);
  assert.equal(snapshot.head, head);
  assert.ok(snapshot.commits.length > 30);
  assert.equal(snapshot.commits.filter(commit => commit.immutable).length, 1);
  assert.ok(snapshot.commits.some(commit => commit.description === '' && commit.commitId !== head));
  for (const text of ['rename from', 'deleted file mode', 'new file mode', 'Binary', 'old mode', '\\ No newline at end of file', '<script>alert(1)</script>']) {
    assert.ok(snapshot.patch.includes(text) || snapshot.commits.some(commit => commit.description.includes(text)), text);
  }

  const other = path.join(parent, 'other');
  await mkdir(other);
  await writeFile(path.join(other, 'keep'), '');
  await assert.rejects(generateDemo(other), /not a demo directory/);
});
