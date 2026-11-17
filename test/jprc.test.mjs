import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCreatePr } from '../src/config.mjs';

const fishQuote = value => `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
const example = ['fish', '-c', 'jprc $argv', '--'];
test('documented fish argv prefix forwards appended arguments to a stub function', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lavish-jprc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'lavish-kit'));
  await writeFile(path.join(dir, 'lavish-kit/config.json'), JSON.stringify({ createPr: example }));
  const { argv } = await readCreatePr({ env: { XDG_CONFIG_HOME: dir } });
  assert.deepEqual(argv, example);
  await mkdir(path.join(dir, 'fish/functions'), { recursive: true });
  const stub = path.join(dir, 'fish/functions/jprc.fish');
  await writeFile(stub, 'function jprc\n    printf "%s\\0" $argv\nend\n');
  for (const rev of ['@-', "a'b\\c $HOME ; (false)\n雪", 'foo|bar']) {
    const args = ['-r', rev, '--body-file', path.join(dir, "draft ' \\ $HOME ; (false) 雪.md")];
    // Load only our stub, then execute the exact configured -c argv prefix.
    const captured = execFileSync(argv[0], ['--no-config', '-C', `source ${fishQuote(stub)}`, ...argv.slice(1), ...args], { env: { ...process.env, XDG_CONFIG_HOME: dir }, encoding: 'utf8' });
    assert.deepEqual(captured.split('\0').slice(0, -1), args);
  }
});

