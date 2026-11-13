import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { writeMarkdown } from '../src/markdown.mjs';
import { writeDiffPage } from '../src/diff/page.mjs';
import { prepareDiff, readDiff } from '../src/diff/source.mjs';
import { writeTaskPage, publishDocument } from '../src/document-page.mjs';
import { writePRPage } from '../src/pr-page.mjs';
import { isolatedLavish, launchBrowser, offlineRoutes, readLayoutIssues } from './visual/browser.mjs';
import { scanDocument, failedChecks } from './visual/checks.mjs';

const root = path.resolve(import.meta.dirname, '..');
const fixtures = path.join(root, 'test/visual/fixtures');
const out = path.join(root, 'shots');
const deps = createRequire(import.meta.url);
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const variants = [
  { kind: 'html', name: 'document' }, { kind: 'markdown', name: 'document' },
  { kind: 'diff', name: 'jj' }, { kind: 'diff', name: 'empty' },
  ...['short', 'long', 'empty'].flatMap(name => ['edit', 'rendered'].map(view => ({ kind: 'task', name, view }))),
  { kind: 'task', name: 'changed-on-disk', view: 'edit' },
  ...['configured', 'unconfigured'].flatMap(name => ['edit', 'rendered'].map(view => ({ kind: 'pr', name, view }))),
];

async function scratchDiff(dir) {
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
  // Both git and jj feed the same renderer and patch parser. git's metadata
  // differs, not its layout, so an equivalent git matrix is unnecessary.
  for (const expected of ['new file mode', 'deleted file mode', 'rename from', '-export const mode', '+export const mode']) {
    if (!source.patch.includes(expected)) throw new Error(`Scratch jj diff lacks ${expected}`);
  }
  return { ...source, root: '/example/repo', revision: 'a'.repeat(40), commits: ['aaaaaaa Screenshot changes'], generated: '2026-01-01T00:00:00.000Z' };
}

async function makePage(variant, dir, dist, diff, env) {
  const file = path.join(dir, 'page', 'index.html'); await mkdir(path.dirname(file), { recursive: true });
  if (variant.kind === 'html') {
    await cp(path.join(fixtures, 'clean.html'), file);
  } else if (variant.kind === 'markdown') {
    const source = path.join(dir, 'document.md'); await cp(path.join(fixtures, 'document.md'), source);
    await writeMarkdown(source, deps, { out: file });
  } else if (variant.kind === 'diff') {
    await writeDiffPage({ ...diff, patch: variant.name === 'empty' ? '' : diff.patch }, dist, file);
  } else {
    const source = path.join(dir, `${variant.kind}.md`);
    if (variant.name === 'empty') await writeFile(source, '');
    else await cp(path.join(fixtures, variant.kind === 'pr' ? 'pr.md' : variant.name === 'long' ? 'task-long.md' : 'task-short.md'), source);
    if (variant.kind === 'task') await writeTaskPage(source, dist, { out: file, title: `Task: ${variant.name}` });
    else {
      const config = path.join(env.XDG_CONFIG_HOME, 'lavish-kit', 'config.json');
      await mkdir(path.dirname(config), { recursive: true });
      if (variant.name === 'configured') await writeFile(config, JSON.stringify({ createPr: ['stub-pr-not-launched'] }));
      else await rm(config, { force: true });
      await writePRPage(source, dist, { repo: '/example/repo', rev: '@-', head: 'a'.repeat(40), commits: ['aaaaaaa Add the document editor'] }, { out: file });
    }
    return { file, source };
  }
  return { file };
}

async function ready(page, variant, artifact) {
  const frame = page.frames().find(f => f.parentFrame() === page.mainFrame());
  if (!frame) throw new Error('Lavish artifact iframe did not load');
  if (variant.kind === 'diff') {
    await frame.waitForSelector('.sidebar');
    if (variant.name !== 'empty') await frame.waitForSelector('[data-content] [data-line-type="change-addition"] span[style]', { timeout: 20000 });
  } else if (['task', 'pr'].includes(variant.kind)) {
    await frame.getByRole('status').filter({ hasText: 'Up to date with disk' }).waitFor();
    if (variant.view === 'rendered') {
      await frame.getByRole('button', { name: 'Rendered', exact: true }).click();
      await frame.waitForFunction(() => document.querySelector('#preview')?.hidden === false);
    }
    if (variant.name === 'changed-on-disk') {
      await frame.getByRole('textbox', { name: 'Markdown text' }).fill('# Unsaved browser edit\n');
      await writeFile(artifact.source, '# External disk update\n');
      await publishDocument(artifact.file, artifact.source);
      await frame.getByRole('button', { name: 'Keep mine', exact: true }).waitFor();
    }
  } else await frame.waitForSelector('h1');
  await frame.evaluate(async () => { await document.fonts.ready; await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))); });
  return frame;
}

async function captureScrolls(page, frame, id) {
  const captures = [];
  // Full-page browser captures include chrome. An iframe with its own scroll
  // area needs additional viewport captures; scrolling preserves the actual UI.
  await page.screenshot({ path: path.join(out, `${id}-full.png`), fullPage: true });
  captures.push(`${id}-full.png`);
  const targets = await frame.evaluate(() => {
    const found = [];
    const walk = root => { for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) walk(el.shadowRoot); if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(el).overflowY)) found.push(el); } };
    walk(document); if (document.scrollingElement.scrollHeight > innerHeight + 1) found.unshift(document.scrollingElement);
    window.__shotScrollTargets = found;
    return found.map(el => ({ height: el.clientHeight, total: el.scrollHeight }));
  });
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    for (let top = target.height, number = 1; top < target.total; top += target.height, number++) {
      await frame.evaluate(({ i, top }) => { window.__shotScrollTargets[i].scrollTop = top; }, { i, top });
      await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const name = `${id}-scroll-${i + 1}-${number}.png`;
      await page.screenshot({ path: path.join(out, name) }); captures.push(name);
    }
    await frame.evaluate(i => { window.__shotScrollTargets[i].scrollTop = 0; }, i);
  }
  return captures;
}

function gallery(report) {
  const groups = [...new Set(report.shots.map(shot => shot.kind))].map(kind => `<section><h2>${escape(kind)}</h2>${report.shots.filter(shot => shot.kind === kind).map(shot => `<article><h3>${escape(shot.id)}</h3><a href="${shot.png}"><img src="${shot.png}" alt="${escape(shot.id)} screenshot" loading="lazy"></a><p>${shot.failures.length ? `FAIL: ${escape(shot.failures.join(', '))}` : 'PASS'}</p><details><summary>Check results</summary><pre>${escape(JSON.stringify(shot.checks, null, 2))}</pre></details>${shot.additionalCaptures.map(name => `<a href="${name}">${name}</a>`).join(' · ')}</article>`).join('')}</section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Screenshot and layout checks</title><style>body{font:16px system-ui;margin:2rem;background:#fafafa;color:#171717}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:1rem}h2{grid-column:1/-1}article{border:1px solid #aaa;padding:1rem;min-width:0}img{width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{overflow-wrap:anywhere}h3{overflow-wrap:anywhere}</style></head><body><h1>Screenshot and layout checks</h1><p>${report.shots.length} shots; ${report.shots.filter(shot => shot.failures.length).length} failed. <a href="report.json">JSON report</a></p><p>Viewport images include Lavish chrome and its artifact iframe. Full-page and scroll captures are linked where content scrolls.</p>${groups}</body></html>\n`;
}

const report = { version: 1, matrix: { viewports: [{ width: 1440, height: 900 }, { width: 480, height: 900 }], colorSchemes: ['light', 'dark'], gitDiff: 'Same renderer and parser as jj; equivalent git matrix omitted' }, shots: [] };
let lavish, browser, interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; browser?.close().catch(() => {}); });
const oldConfig = process.env.XDG_CONFIG_HOME;
try {
  await rm(out, { recursive: true, force: true }); await mkdir(out);
  lavish = await isolatedLavish(); process.env.XDG_CONFIG_HOME = lavish.env.XDG_CONFIG_HOME;
  const dist = path.join(lavish.dir, 'dist'); await mkdir(dist);
  execFileSync(process.execPath, [path.join(root, 'build.mjs'), root, dist]);
  const diff = await scratchDiff(lavish.dir);
  browser = await launchBrowser();
  for (const variant of variants) for (const viewport of report.matrix.viewports) for (const colorScheme of report.matrix.colorSchemes) {
    if (interrupted) throw new Error('Screenshot run interrupted');
    const id = [variant.kind, variant.name, variant.view, viewport.width === 1440 ? 'wide' : 'narrow', colorScheme].filter(Boolean).join('-');
    const dir = path.join(lavish.dir, id); await mkdir(dir);
    const artifact = await makePage(variant, dir, dist, diff, lavish.env);
    const context = await browser.newContext({ viewport, colorScheme }); const page = await context.newPage();
    const pageErrors = [], consoleErrors = [];
    const sanitize = text => text.replaceAll(lavish.dir, '<temp>').replace(/http:\/\/(?:localhost|127\.0\.0\.1):\d+/g, '<lavish>').replace(/\/(artifact|api|session)\/[a-f0-9]{16}/g, '/$1/<session>');
    page.on('pageerror', error => pageErrors.push(sanitize(error.message)));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(sanitize(message.text())); });
    const shot = { id, ...variant, viewport, colorScheme, png: `${id}.png`, additionalCaptures: [], checks: {} };
    try {
      await offlineRoutes(page); await page.goto(lavish.open(artifact.file));
      const frame = await ready(page, variant, artifact);
      shot.checks.lavishLayout = await readLayoutIssues(page);
      const artifactScan = await scanDocument(frame), chromeScan = await scanDocument(page.mainFrame());
      shot.checks.horizontalOverflow = artifactScan.geometry.horizontalOverflow;
      shot.checks.clippedText = artifactScan.geometry.clippedText;
      shot.checks.controls = artifactScan.geometry.controls;
      shot.checks.accessibility = [{ scope: 'artifact', violations: artifactScan.accessibility }, { scope: 'chrome', violations: chromeScan.accessibility }].filter(scan => scan.violations.length);
      await page.screenshot({ path: path.join(out, shot.png) });
      if (artifactScan.geometry.scrolls) shot.additionalCaptures = await captureScrolls(page, frame, id);
      shot.checks.pageErrors = [...new Set(pageErrors)].sort();
      shot.checks.consoleErrors = [...new Set(consoleErrors)].sort();
    } catch (error) {
      shot.checks.checkerErrors = [sanitize(error.message)];
      await page.screenshot({ path: path.join(out, shot.png) }).catch(() => {});
    } finally { await context.close(); }
    shot.failures = failedChecks(shot.checks); report.shots.push(shot);
    console.log(`${shot.failures.length ? `FAIL ${shot.failures.join(', ')}` : 'PASS'} shots/${shot.png}`);
  }
} catch (error) {
  report.runnerErrors = [error.message]; console.error(error.message);
} finally {
  await browser?.close();
  if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldConfig;
  if (lavish) { try { report.cleanup = await lavish.close(); } catch (error) { report.cleanupErrors = [error.message]; console.error(error.message); } }
}
await writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(path.join(out, 'index.html'), gallery(report));
const failed = report.shots.filter(shot => shot.failures.length).length;
console.log(`${report.shots.length} shots, ${failed} failed; shots/index.html; cleanup: ${JSON.stringify(report.cleanup || report.cleanupErrors)}`);
process.exitCode = failed || report.runnerErrors || report.cleanupErrors ? 1 : 0;
