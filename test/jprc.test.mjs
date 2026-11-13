import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCreatePr } from '../src/config.mjs';
import { preparePR } from '../src/pr-page.mjs';

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

test('PR metadata captures a single jj revision in the recorded repository', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lavish-pr-metadata-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = (args) => execFileSync('jj', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  run(['git', 'init', '--colocate']);
  run(['config', 'set', '--repo', 'user.name', 'Test']);
  run(['config', 'set', '--repo', 'user.email', 'test@example.invalid']);
  run(['config', 'set', '--repo', 'revset-aliases."trunk()"', 'root()']);
  await writeFile(path.join(dir, 'change.txt'), 'Change\n');
  run(['commit', '-m', 'Commit title\n\nCommit body']);
  const metadata = await preparePR('@-', dir);
  assert.equal(metadata.repo, await realpath(dir));
  assert.equal(metadata.rev, '@-'); assert.match(metadata.head, /^[a-f0-9]{40}$/);
  assert.ok(metadata.commits.some(line => line.endsWith('Commit title')));
  await assert.rejects(preparePR('root() | @', dir), /exactly one commit/);
  await assert.rejects(preparePR('missing_revision', dir));
});
