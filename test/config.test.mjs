import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configPath, readCreatePr } from '../src/config.mjs';

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

