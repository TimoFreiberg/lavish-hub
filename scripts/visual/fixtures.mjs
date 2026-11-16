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
  ...['empty', 'stack', 'dirty', 'conflict', 'disconnected', 'changes', 'tasks', 'pr', 'markdown', 'html'].map(name => ({ kind: 'hub', name })),
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
  if (variant.kind === 'hub') {
    const [script, style, diffScript, diffStyle, markdown, documentStyle] = await Promise.all([
      readFile(path.join(root, 'web/hub-app.mjs'), 'utf8'), readFile(path.join(root, 'web/hub.css'), 'utf8'),
      readFile(path.join(dist, 'diff-app.js'), 'utf8'), readFile(path.join(dist, 'diff.css'), 'utf8'),
      readFile(path.join(dist, 'hub-markdown.js'), 'utf8'), readFile(path.join(dist, 'document.css'), 'utf8'),
    ]);
    const name = variant.name;
    const selected = ['changes', 'tasks', 'pr', 'markdown', 'html'].includes(name) ? name : 'commits';
    const commits = name === 'empty' ? [] : Array.from({ length: name === 'stack' ? 8 : 1 }, (_, i) => ({ changeId: String(i + 1).repeat(32), commitId: String(i + 1).repeat(40), description: name === 'stack' ? `Long description ${i + 1}\n\n${'A detailed explanation of this change and its consequences. '.repeat(5)}` : 'Improve the workspace review\n\nKeep the description readable.', immutable: false, divergent: false }));
    const data = { selected, commits, patch: diff.patch, stat: '4 files changed, 28 insertions(+), 7 deletions(-)', documents: [{ id: 'markdown', title: 'Review notes', source: 'review.md', metadata: { reviewedRepository: 'Example repository', headCommit: 'a'.repeat(40) } }, { id: 'html', title: 'Review HTML', source: 'review.html' }] };
    const bootstrap = `const fixture=${JSON.stringify(data).replaceAll('<', '\\u003c')}; globalThis.hubConfig={url:'',capability:'fixture',resourceKey:'fixture',workspace:'/example/workspace'}; globalThis.fetch=async (_url,options)=>{const {operation,id}=JSON.parse(options.body); const result=operation==='status'?{available:true,selected:fixture.selected}:operation==='documents'?{documents:fixture.documents}:operation==='snapshot'?{base:'a'.repeat(40),head:'b'.repeat(40),stat:fixture.stat,patch:fixture.patch,commits:fixture.commits}:operation==='readDocument'?{text:id==='tasks'?'- [ ] Review the changes\\n- [x] Run the tests\\n':id==='pr'?'# Improve workspace review\\n\\nDescribe the changes and testing.\\n':'# Review notes\\n\\nA published Markdown document.\\n',hash:'fixture',version:'fixture'}:operation==='describe'?{status:'conflict',reason:'changed on disk',current:[{description:'External update'}]}:{}; return {ok:true,json:async()=>({result})};};`;
    const safe = value => value.replaceAll('</script', '<\\/script');
    await Promise.all([
      writeFile(path.join(path.dirname(file), 'hub.css'), `${style}\n@scope (.hub-diff) { ${diffStyle} } @scope (.hub-markdown) { ${documentStyle} }`),
      writeFile(path.join(path.dirname(file), 'diff.js'), diffScript), writeFile(path.join(path.dirname(file), 'markdown.js'), markdown),
      writeFile(path.join(path.dirname(file), 'hub.js'), script),
    ]);
    const styles = portable ? '<link rel="stylesheet" href="hub.css">' : `<style>${style}\n@scope (.hub-diff) { ${diffStyle} } @scope (.hub-markdown) { ${documentStyle} }</style>`;
    const scripts = portable ? '<script src="diff.js"></script><script src="markdown.js"></script><script type="module" src="hub.js"></script>' : `<script>${safe(diffScript)}</script><script>${safe(markdown)}</script><script type="module">${safe(script)}</script>`;
    await writeFile(file, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workspace hub fixture</title>${styles}</head><body><div id="app"></div><script>${safe(bootstrap)}</script>${scripts}</body></html>`);
  } else if (variant.kind === 'html') {
    if (portable) {
      const html = await readFile(path.join(fixtures, 'clean.html'), 'utf8');
      await writeFile(file, html.replace('</body>', '<style>:root[data-theme="dark"] body { color: #e6edf3; background: #0d1117; color-scheme: dark; }</style><script src="../../assets/preview.js"></script></body>'));
    } else await cp(path.join(fixtures, 'clean.html'), file);
  } else if (variant.kind === 'markdown') {
    const source = path.join(dir, 'document.md'); await cp(path.join(fixtures, 'document.md'), source);
    await writeMarkdown(source, deps, { out: file, ...(portable && { assetBase: '../../assets', bootstrap: '../../assets/preview.js' }) });
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
