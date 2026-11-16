import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHubDocuments } from '../src/hub-documents.mjs';
import { createHubJj } from '../src/hub-jj.mjs';
import { createHubPr } from '../src/hub-pr.mjs';

const jj = (cwd, ...args) => execFileSync('jj', ['--no-pager', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('PR launch saves, pins the head and checkpoints before herdr', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-pr-'));
  try {
    const repo = path.join(dir, 'repo'), state = path.join(dir, 'state'), config = path.join(dir, 'config');
    await mkdir(repo); await mkdir(path.join(config, 'lavish-kit'), { recursive: true });
    jj(repo, 'git', 'init');
    await writeFile(path.join(repo, 'file'), 'parent'); jj(repo, 'new');
    await writeFile(path.join(repo, 'file'), 'working');
    await writeFile(path.join(config, 'lavish-kit', 'config.json'), JSON.stringify({ createPr: ['first'] }));
    const docs = await createHubDocuments(state), vcs = createHubJj(repo);
    const initial = await docs.read({ id: 'pr' });
    let launched;
    const launch = await createHubPr(state, repo, docs, vcs, { env: { XDG_CONFIG_HOME: config, HC_TERMINAL_ID: 'terminal' }, log: () => {}, run: async (cmd, args) => {
      if (cmd === 'hc') return { stdout: JSON.stringify({ state: 'live', labels: { 'herdr.space': 'space' } }) };
      assert.equal(JSON.parse(await readFile(path.join(state, 'attempts', 'request.json'), 'utf8')).status, 'interrupted-or-running');
      assert.equal(await readFile(initial.source, 'utf8'), '# Title\nBody');
      launched = JSON.parse(args[2]);
      jj(repo, 'describe', '-r', '@-', '-m', 'rewritten');
      return { stdout: JSON.stringify({ space: 'space', tab: 'tab', terminal: 'terminal' }) };
    } });
    await writeFile(path.join(config, 'lavish-kit', 'config.json'), JSON.stringify({ createPr: ['second'] }));
    const body = { id: 'request', version: initial.version, baseHash: initial.hash, text: '# Title\nBody' };
    const result = await launch(body);
    assert.equal(result.status, 'launched'); assert.match(result.warning, /excluded/);
    assert.equal(launched.argv[0], 'second'); assert.equal(launched.argv[2], result.revision);
    assert.notEqual(jj(repo, 'log', '-r', '@-', '--no-graph', '-T', 'commit_id'), result.revision);
    assert.deepEqual(await launch(body), result);
    const explicit = await vcs.prHead('@'); assert.equal(explicit.revision, jj(repo, 'log', '-r', '@', '--no-graph', '-T', 'commit_id')); assert.match(explicit.warning, /working-copy commit/);
    await assert.rejects(vcs.prHead('none()'), /exactly one/);
    jj(repo, 'new'); assert.equal((await vcs.prHead()).warning, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('PR fallback and stale attachments do not launch', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-pr-'));
  try {
    const repo = path.join(dir, 'repo'), config = path.join(dir, 'config'); await mkdir(repo); jj(repo, 'git', 'init'); jj(repo, 'new');
    await mkdir(path.join(config, 'lavish-kit'), { recursive: true }); await writeFile(path.join(config, 'lavish-kit', 'config.json'), '{"createPr":["pr command"]}');
    const docs = await createHubDocuments(path.join(dir, 'state')), vcs = createHubJj(repo), initial = await docs.read({ id: 'pr' });
    const launch = await createHubPr(path.join(dir, 'state'), repo, docs, vcs, { env: { XDG_CONFIG_HOME: config }, log: () => {} });
    const result = await launch({ id: 'fallback', version: initial.version, baseHash: initial.hash, text: '# Title\n' });
    assert.equal(result.status, 'fallback'); assert.match(result.command, /'pr command'/);
    const other = path.join(dir, 'other.md'); await writeFile(other, '# Other\n'); await docs.attach({ kind: 'pr', file: other });
    assert.equal((await launch({ id: 'stale', version: initial.version, baseHash: initial.hash, text: '# Old\n' })).status, 'error');
    assert.equal(await readFile(other, 'utf8'), '# Other\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
