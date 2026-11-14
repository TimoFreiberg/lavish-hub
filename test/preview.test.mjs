import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { variants, variantId } from '../scripts/visual/fixtures.mjs';

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
    await writeFile(path.join(dir, 'html-document', 'page', 'personal.txt'), 'page note');
    execFileSync(process.execPath, ['scripts/preview.mjs', dir], { cwd: root, stdio: 'pipe' });
    const backups = (await readdir(parent)).filter(name => name.startsWith('preview-previous-'));
    const notes = await Promise.all(backups.map(async name => {
      try { return await readFile(path.join(parent, name, 'preview', 'assets', 'personal.txt'), 'utf8'); } catch { return null; }
    }));
    const currentBackup = backups[notes.indexOf('asset note')];
    assert.ok(currentBackup);
    assert.equal(await readFile(path.join(parent, currentBackup, 'preview', 'html-document', 'page', 'personal.txt'), 'utf8'), 'page note');
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
    assert.equal(manifest.revision, execFileSync('jj', ['log', '-r', '@', '--no-graph', '-T', 'commit_id'], { cwd: root, encoding: 'utf8' }).trim());
    assert.deepEqual(manifest.pages.map(page => page.id), variants.map(variantId));
    const index = await readFile(path.join(dir, 'index.html'), 'utf8');
    for (const page of manifest.pages) {
      assert.ok(index.includes(`href="${page.url}"`));
      const html = await readFile(path.join(dir, page.url), 'utf8');
      assert.doesNotMatch(html, /https?:\/\//);
      if (['task', 'pr', 'diff'].includes(page.kind)) assert.match(html, /\.\.\/\.\.\/assets\/preview\.js/);
      for (const name of await readdir(path.dirname(path.join(dir, page.url)))) {
        if (name.startsWith('data-')) assert.doesNotMatch(await readFile(path.join(dir, path.dirname(page.url), name), 'utf8'), /\/(?:Users|home|private\/var)\//);
      }
    }
    for (const name of ['daisyui.css', 'themes.css', 'tailwind.js', 'preview.js']) assert.ok((await readFile(path.join(dir, 'assets', name))).length);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
