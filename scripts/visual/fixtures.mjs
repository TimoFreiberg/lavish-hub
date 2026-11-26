import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { prepareDiff, readDiff } from '../../src/diff/source.mjs';
import { themeCss } from '../../src/orangebox.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const fixtures = path.join(root, 'test/visual/fixtures');
export const variants = ['empty', 'stack', 'dirty', 'conflict', 'disconnected', 'changes', 'tasks', 'markdown', 'html']
  .map(name => ({ kind: 'hub', name }));
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
    const [script, style, diffScript, diffStyle, markdown, documentStyle, confirmNavigation, hubLifecycle] = await Promise.all([
      readFile(path.join(root, 'web/hub-app.mjs'), 'utf8'), readFile(path.join(root, 'web/hub.css'), 'utf8'),
      readFile(path.join(dist, 'diff-app.js'), 'utf8'), readFile(path.join(dist, 'diff.css'), 'utf8'),
      readFile(path.join(dist, 'hub-markdown.js'), 'utf8'), readFile(path.join(dist, 'document.css'), 'utf8'),
      readFile(path.join(root, 'web/confirm-navigation.js'), 'utf8'), readFile(path.join(root, 'web/hub-lifecycle.js'), 'utf8'),
    ]);
    const name = variant.name;
    const selected = ['changes', 'tasks', 'markdown', 'html'].includes(name) ? name : 'commits';
    const commits = name === 'empty' ? [] : Array.from({ length: name === 'stack' ? 8 : 1 }, (_, i) => ({ changeId: String(i + 1).repeat(32), commitId: String(i + 1).repeat(40), description: name === 'stack' ? `Long description ${i + 1}\n\n${'A detailed explanation of this change and its consequences. '.repeat(5)}` : 'Improve the workspace review\n\nKeep the description readable.', immutable: false, divergent: false }));
    const data = { selected, commits, patch: diff.patch, stat: '4 files changed, 28 insertions(+), 7 deletions(-)', documents: [{ id: 'markdown', title: 'Review notes', source: 'review.md', metadata: { reviewedRepository: 'Example repository', headCommit: 'a'.repeat(40) } }, { id: 'html', title: 'Review HTML', source: 'review.html' }] };
    const bootstrap = `const fixture=${JSON.stringify(data).replaceAll('<', '\\u003c')}; globalThis.hubConfig={url:${JSON.stringify(portable ? '.' : '')},capability:'fixture',resourceKey:'fixture',workspace:'/example/workspace'}; globalThis.fetch=async (_url,options)=>{const {operation,id}=JSON.parse(options.body); const result=operation==='status'?{available:true,selected:fixture.selected}:operation==='documents'?{documents:fixture.documents}:operation==='snapshot'?{base:'a'.repeat(40),head:'b'.repeat(40),stat:fixture.stat,patch:fixture.patch,commits:fixture.commits}:operation==='readDocument'?{text:id==='tasks'?'- [ ] Review the changes\\n- [x] Run the tests\\n':'# Review notes\\n\\nA published Markdown document.\\n',hash:'fixture',version:'fixture'}:operation==='describe'?{status:'conflict',reason:'changed on disk',current:[{description:'External update'}]}:{}; return {ok:true,json:async()=>({result})};};`;
    const safe = value => value.replaceAll('</script', '<\\/script');
    if (portable) {
      const resource = path.join(path.dirname(file), 'resources/fixture/html');
      await mkdir(resource, { recursive: true });
      await cp(path.join(fixtures, 'clean.html'), path.join(resource, 'review.html'));
    }
    await Promise.all([
      writeFile(path.join(path.dirname(file), 'hub.css'), `${themeCss}\n${style}\n@scope (.hub-diff) { ${diffStyle} } @scope (.hub-markdown) { ${documentStyle} }`),
      writeFile(path.join(path.dirname(file), 'diff.js'), diffScript), writeFile(path.join(path.dirname(file), 'markdown.js'), markdown),
      writeFile(path.join(path.dirname(file), 'hub.js'), script),
      writeFile(path.join(path.dirname(file), 'confirm-navigation.js'), confirmNavigation), writeFile(path.join(path.dirname(file), 'hub-lifecycle.js'), hubLifecycle),
    ]);
    const styles = portable ? '<link rel="stylesheet" href="hub.css">' : `<style>${themeCss}\n${style}\n@scope (.hub-diff) { ${diffStyle} } @scope (.hub-markdown) { ${documentStyle} }</style>`;
    const scripts = portable ? '<script src="../../assets/preview.js"></script><script src="diff.js"></script><script src="markdown.js"></script><script src="confirm-navigation.js"></script><script src="hub-lifecycle.js"></script><script type="module" src="hub.js"></script>' : `<script>${safe(diffScript)}</script><script>${safe(markdown)}</script><script>${safe(confirmNavigation)}</script><script>${safe(hubLifecycle)}</script><script type="module">${safe(script)}</script>`;
    await writeFile(file, `<!doctype html><html lang="en" data-theme="orangebox"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workspace hub fixture</title>${styles}</head><body><div id="app"></div><script>${safe(bootstrap)}</script>${scripts}</body></html>`);
  } else throw new Error(`Unknown visual fixture: ${variant.kind}`);
  return { file };
}
