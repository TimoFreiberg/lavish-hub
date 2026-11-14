import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { writeMarkdown } from '../../src/markdown.mjs';
import { writeDiffPage } from '../../src/diff/page.mjs';
import { prepareDiff, readDiff } from '../../src/diff/source.mjs';
import { writeTaskPage } from '../../src/document-page.mjs';
import { writePRPage } from '../../src/pr-page.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const fixtures = path.join(root, 'test/visual/fixtures');
const deps = createRequire(import.meta.url);
export const variants = [
  { kind: 'html', name: 'document' }, { kind: 'markdown', name: 'document' },
  { kind: 'diff', name: 'jj' }, { kind: 'diff', name: 'empty' },
  ...['short', 'long', 'empty'].flatMap(name => ['edit', 'rendered'].map(view => ({ kind: 'task', name, view }))),
  { kind: 'task', name: 'changed-on-disk', view: 'edit' },
  ...['configured', 'unconfigured'].flatMap(name => ['edit', 'rendered'].map(view => ({ kind: 'pr', name, view }))),
];
export const variantId = variant => [variant.kind, variant.name, variant.view].filter(Boolean).join('-');

export async function scratchDiff(dir) {
  const repo = path.join(dir, 'repo'); await mkdir(repo);
  const jj = args => execFileSync('jj', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  jj(['git', 'init']);
  const fixture = JSON.parse(await readFile(path.join(fixtures, 'diff.json'), 'utf8'));
  for (const [name, text] of Object.entries(fixture.before)) await writeFile(path.join(repo, name), text);
  jj(['new', '-m', 'Screenshot fixture base']);
  for (const name of Object.keys(fixture.before)) await rm(path.join(repo, name));
  for (const [name, text] of Object.entries(fixture.after)) await writeFile(path.join(repo, name), text);
  await writeFile(path.join(repo, fixture.largeFile.name), Array.from({ length: fixture.largeFile.lines }, (_, i) => `export const item${i} = ${i};\n`).join(''));
  await writeFile(path.join(repo, fixture.longLine.name), `${fixture.longLine.text.repeat(fixture.longLine.repeat)}\n`);
  const source = await readDiff(await prepareDiff({ rev: '@' }, repo));
  for (const expected of ['new file mode', 'deleted file mode', 'rename from', '-export const mode', '+export const mode']) {
    if (!source.patch.includes(expected)) throw new Error(`Scratch jj diff lacks ${expected}`);
  }
  return { ...source, root: '/example/repo', revision: 'a'.repeat(40), commits: ['aaaaaaa Screenshot changes'], generated: '2026-01-01T00:00:00.000Z' };
}

export async function makePage(variant, dir, dist, diff, { portable = false } = {}) {
  const file = path.join(dir, 'page', 'index.html'); await mkdir(path.dirname(file), { recursive: true });
  if (variant.kind === 'html') {
    await cp(path.join(fixtures, 'clean.html'), file);
  } else if (variant.kind === 'markdown') {
    const source = path.join(dir, 'document.md'); await cp(path.join(fixtures, 'document.md'), source);
    await writeMarkdown(source, deps, { out: file, ...(portable && { assetBase: '../../assets' }) });
  } else if (variant.kind === 'diff') {
    await writeDiffPage({ ...diff, patch: variant.name === 'empty' ? '' : diff.patch }, dist, file, portable ? { bootstrap: '../../assets/preview.js' } : {});
  } else {
    const source = path.join(dir, `${variant.kind}.md`);
    if (variant.name === 'empty') await writeFile(source, '');
    else await cp(path.join(fixtures, variant.kind === 'pr' ? 'pr.md' : variant.name === 'long' ? 'task-long.md' : 'task-short.md'), source);
    const options = { out: file, ...(portable && { sourceName: 'fixture.md', bootstrap: '../../assets/preview.js' }) };
    if (variant.kind === 'task') await writeTaskPage(source, dist, { ...options, title: `Task: ${variant.name}` });
    else await writePRPage(source, dist, { repo: '/example/repo', rev: '@-', head: 'a'.repeat(40), commits: ['aaaaaaa Add the document editor'] }, { ...options, createPr: variant.name === 'configured' ? { enabled: true } : { enabled: false, reason: 'Create PR is not configured' } });
    return { file, source };
  }
  return { file };
}
