import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { variants, variantId } from '../scripts/visual/fixtures.mjs';

test('provenance follows isolated jj and Git checkouts', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const parent = await mkdtemp(path.join(os.tmpdir(), 'preview-provenance-'));
  const run = (cwd, command, args) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } }).trim();
  try {
    run(parent, 'jj', ['git', 'init']);
    for (const kind of ['jj', 'git']) {
      const repo = path.join(parent, kind); await mkdir(repo);
      for (const name of ['scripts', 'src', 'web', 'build.mjs', 'package.json', 'package-lock.json']) {
        await cp(path.join(root, name), path.join(repo, name), { recursive: true });
      }
      await mkdir(path.join(repo, 'test', 'visual'), { recursive: true });
      await cp(path.join(root, 'test', 'visual', 'fixtures'), path.join(repo, 'test', 'visual', 'fixtures'), { recursive: true });
      await symlink(path.join(root, 'node_modules'), path.join(repo, 'node_modules'), 'dir');
      await writeFile(path.join(repo, '.gitignore'), 'node_modules\n');
      if (kind === 'jj') {
        run(repo, 'jj', ['git', 'init']);
        run(repo, 'jj', ['new', '-m', 'Fixture']);
      } else {
        run(repo, 'git', ['init']);
        run(repo, 'git', ['add', '.']);
        run(repo, 'git', ['commit', '-m', 'Fixture']);
      }
      const generate = async label => {
        const revision = kind === 'jj' ? run(repo, 'jj', ['log', '-r', '@', '--no-graph', '-T', 'commit_id']) : run(repo, 'git', ['rev-parse', 'HEAD']);
        const out = path.join(parent, `${kind}-${label}`);
        run(repo, process.execPath, ['scripts/preview.mjs', out]);
        const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
        assert.deepEqual(Object.keys(manifest).sort(), ['generator', 'version', 'fixtureVersion', 'revision', 'dirty', 'timestamp', 'pages'].sort());
        assert.equal(manifest.generator, 'lavish-kit-preview');
        assert.equal(manifest.version, 1);
        assert.equal(manifest.revision, revision);
        const index = await readFile(path.join(out, 'index.html'), 'utf8');
        assert.match(index, /Simulated interactions do not save files or run actions/);
        assert.doesNotMatch(index, /not published/i);
        return manifest;
      };
      assert.equal((await generate('clean')).dirty, false);
      await writeFile(path.join(repo, 'changed.txt'), 'change\n');
      assert.equal((await generate('dirty')).dirty, true);
      if (kind === 'git') {
        run(repo, 'git', ['add', 'changed.txt']);
        assert.equal((await generate('staged')).dirty, true);
      }
    }
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('legacy preview is preserved and unrelated output is refused', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const parent = await mkdtemp(path.join(os.tmpdir(), 'preview-legacy-'));
  const dir = path.join(parent, 'preview');
  try {
    await mkdir(dir);
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ version: 1, pages: [{ id: 'html-document', url: 'html-document/page/index.html' }] }));
    await writeFile(path.join(dir, 'personal.txt'), 'preserve me');
    execFileSync(process.execPath, ['scripts/preview.mjs', dir], { cwd: root, stdio: 'pipe' });
    const backup = (await readdir(parent)).find(name => name.startsWith('preview-previous-'));
    assert.ok(backup);
    assert.equal(await readFile(path.join(parent, backup, 'preview', 'personal.txt'), 'utf8'), 'preserve me');
    assert.equal(JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')).generator, 'lavish-kit-preview');
    await writeFile(path.join(dir, 'assets', 'personal.txt'), 'asset note');
    await writeFile(path.join(dir, 'hub-empty', 'page', 'personal.txt'), 'page note');
    execFileSync(process.execPath, ['scripts/preview.mjs', dir], { cwd: root, stdio: 'pipe' });
    const backups = (await readdir(parent)).filter(name => name.startsWith('preview-previous-'));
    const notes = await Promise.all(backups.map(async name => {
      try { return await readFile(path.join(parent, name, 'preview', 'assets', 'personal.txt'), 'utf8'); } catch { return null; }
    }));
    const currentBackup = backups[notes.indexOf('asset note')];
    assert.ok(currentBackup);
    assert.equal(await readFile(path.join(parent, currentBackup, 'preview', 'hub-empty', 'page', 'personal.txt'), 'utf8'), 'page note');
    const unrelated = path.join(parent, 'unrelated'); await mkdir(unrelated);
    await writeFile(path.join(unrelated, 'personal.txt'), 'untouched');
    assert.throws(() => execFileSync(process.execPath, ['scripts/preview.mjs', unrelated], { cwd: root, stdio: 'pipe' }));
    assert.equal(await readFile(path.join(unrelated, 'personal.txt'), 'utf8'), 'untouched');
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('preview generator writes portable fixture pages and provenance', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'preview-test-'));
  try {
    execFileSync(process.execPath, ['scripts/preview.mjs', dir], { cwd: root, env: { ...process.env, SOURCE_DATE_EPOCH: '0' }, stdio: 'pipe' });
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.timestamp, '1970-01-01T00:00:00.000Z');
    assert.match(manifest.revision, /^[0-9a-f]{40,64}$/);
    assert.deepEqual(manifest.pages.map(page => page.id), variants.map(variantId));
    const index = await readFile(path.join(dir, 'index.html'), 'utf8');
    for (const page of manifest.pages) {
      assert.ok(index.includes(`href="${page.url}"`));
      const html = await readFile(path.join(dir, page.url), 'utf8');
      assert.doesNotMatch(html, /https?:\/\//);
      if (['task', 'diff'].includes(page.kind)) assert.match(html, /\.\.\/\.\.\/assets\/preview\.js/);
      for (const name of await readdir(path.dirname(path.join(dir, page.url)))) {
        if (name.startsWith('data-')) assert.doesNotMatch(await readFile(path.join(dir, path.dirname(page.url), name), 'utf8'), /\/(?:Users|home|private\/var)\//);
      }
    }
    for (const name of ['daisyui.css', 'themes.css', 'tailwind.js', 'preview.js']) assert.ok((await readFile(path.join(dir, 'assets', name))).length);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
