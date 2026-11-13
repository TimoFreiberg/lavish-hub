import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configPath, readCreatePr } from '../src/config.mjs';
import { documentOutputPath } from '../src/document-page.mjs';
import { markdownOutputPath } from '../src/markdown.mjs';
import { pagePath } from '../src/diff/page.mjs';

test('Create PR config accepts argv only, with no default for absent or invalid values', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lavish-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: dir }, file = configPath(env);
  assert.equal(file, path.join(dir, 'lavish-kit/config.json'));
  assert.equal(configPath({}), path.join(os.homedir(), '.config/lavish-kit/config.json'));
  await mkdir(path.dirname(file));
  assert.match((await readCreatePr({ env })).reason, /Set createPr/);
  for (const value of ['{', 'null', '[]', '{}', '{"createPr":"gh"}', '{"createPr":[]}', '{"createPr":[""]}', '{"createPr":["  "]}', '{"createPr":["gh",3]}', JSON.stringify({ createPr: ['gh', '\0'] })]) {
    await writeFile(file, value);
    const result = await readCreatePr({ env });
    assert.equal(result.argv, undefined, value); assert.match(result.reason, /createPr.*array of strings/, value);
  }
  for (const argv of [['stub-command'], ['fish', '-c', 'jprc $argv', '--'], ['stub', '', 'a ; (false)']]) {
    await writeFile(file, JSON.stringify({ createPr: argv }));
    assert.deepEqual(await readCreatePr({ env }), { argv });
  }
});

test('generated pages default to XDG data, or the home data directory', () => {
  const old = process.env.XDG_DATA_HOME;
  try {
    for (const data of ['/example/data', undefined]) {
      if (data === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = data;
      const base = path.join(data || path.join(os.homedir(), '.local/share'), 'lavish-kit/pages');
      assert.ok(documentOutputPath('/example/task.md').startsWith(path.join(base, 'task') + path.sep));
      assert.ok(documentOutputPath('/example/pr.md', undefined, 'pr').startsWith(path.join(base, 'pr') + path.sep));
      assert.ok(markdownOutputPath('/example/doc.md').startsWith(path.join(base, 'markdown') + path.sep));
      assert.ok(pagePath({ root: '/example/repo', rangeSpec: '@' }).startsWith(path.join(base, 'diff') + path.sep));
      assert.equal(documentOutputPath('/example/task.md', '/override/index.html'), '/override/index.html');
      assert.equal(pagePath({}, '/override/index.html'), '/override/index.html');
    }
  } finally {
    if (old === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = old;
  }
});
