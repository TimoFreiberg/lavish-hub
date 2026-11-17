import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

test('release workflow gates publication on the same package passing both smoke jobs', async () => {
  const workflow = parse(await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  const { build, smoke, publish } = workflow.jobs;
  assert.equal(smoke.needs, 'build');
  assert.equal(publish.needs, 'smoke');
  assert.deepEqual(smoke.strategy.matrix.os, ['ubuntu-latest', 'macos-latest']);
  const step = (job, prefix) => job.steps.find(item => item.uses?.startsWith(prefix));
  const upload = step(build, 'actions/upload-artifact@');
  for (const job of [smoke, publish]) {
    assert.equal(step(job, 'actions/download-artifact@').with.name, upload.with.name);
    assert.match(job.steps.map(item => item.run || '').join('\n'), /shasum -a 256 -c SHA256SUMS/);
  }
  assert.match(smoke.steps.map(item => item.run || '').join('\n'), /node test\/package-smoke\.mjs release\/lavish-kit\.tgz/);
  const commands = build.steps.map(item => item.run || '').join('\n');
  assert.match(commands, /git merge-base --is-ancestor "\$SOURCE" origin\/main/);
  assert.match(commands, /gh release view/);
  assert.match(commands, /git ls-remote --tags/);
  assert.match(publish.steps.map(item => item.run || '').join('\n'), /gh release create/);
  assert.equal(publish.permissions.contents, 'write');
  assert.notEqual(build.permissions.contents, 'write');
  assert.notEqual(smoke.permissions.contents, 'write');
});
