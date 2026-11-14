import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isSelected } from './visual/selection.mjs';
import { validateReport } from './visual/report-validation.mjs';
import { runCaptureWorkers } from './visual/workers.mjs';
import path from 'node:path';
import { publishDocument } from '../src/document-page.mjs';
import { variants, scratchDiff, makePage } from './visual/fixtures.mjs';
import { isolatedLavish, launchBrowser, offlineRoutes, readLayoutIssues, closeVisualResources } from './visual/browser.mjs';
import { scanDocument, failedChecks, partitionAccessibility } from './visual/checks.mjs';

const root = path.resolve(import.meta.dirname, '..');
const out = process.env.LAVISH_KIT_SHOTS_DIR ? path.resolve(process.env.LAVISH_KIT_SHOTS_DIR) : path.join(root, 'shots');
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

async function ready(page, variant, artifact, source) {
  const frame = source === 'static' ? page.mainFrame() : page.frames().find(f => f.parentFrame() === page.mainFrame());
  if (!frame) throw new Error('Lavish artifact iframe did not load');
  if (variant.kind === 'diff') {
    await frame.waitForSelector('.sidebar');
    if (variant.name !== 'empty') await frame.waitForSelector('[data-content] [data-line-type="change-addition"] span[style]', { timeout: 20000 });
  } else if (['task', 'pr'].includes(variant.kind)) {
    if (source !== 'static' || variant.name !== 'changed-on-disk') await frame.getByRole('status').filter({ hasText: 'Up to date with disk' }).waitFor();
    await frame.getByRole('button', { name: variant.view === 'edit' ? 'Edit' : 'Rendered', exact: true }).click();
    if (variant.view === 'rendered') {
      await frame.waitForFunction(() => document.querySelector('#preview')?.hidden === false);
      if ((variant.kind === 'task' && variant.name !== 'empty') || variant.kind === 'pr') await frame.waitForSelector('#preview pre.shiki span[style]', { timeout: 20000 });
    }
    if (variant.name === 'changed-on-disk') {
      if (source === 'integration') {
        await frame.getByRole('textbox', { name: 'Markdown text' }).fill('# Unsaved browser edit\n');
        await writeFile(artifact.source, '# External disk update\n');
        await publishDocument(artifact.file, artifact.source);
      }
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
  const groups = [...new Set(report.shots.map(shot => shot.kind))].map(kind => `<section><h2>${escape(kind)}</h2>${report.shots.filter(shot => shot.kind === kind).map(shot => `<article><h3>${escape(shot.id)}</h3>${shot.png ? `<a href="${shot.png}"><img src="${shot.png}" alt="${escape(shot.id)} screenshot" loading="lazy"></a>` : shot.failurePng ? `<a href="${shot.failurePng}">Failure screenshot</a>` : '<p>Diagnostic check only</p>'}<p>${shot.failures.length ? `FAIL: ${escape(shot.failures.join(', '))}` : 'PASS'}</p><details><summary>Check results</summary><pre>${escape(JSON.stringify(shot.checks, null, 2))}</pre></details>${shot.additionalCaptures.map(name => `<a href="${name}">${name}</a>`).join(' · ')}</article>`).join('')}</section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Screenshot and layout checks</title><style>body{font:16px system-ui;margin:2rem;background:#fafafa;color:#171717}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:1rem}h2{grid-column:1/-1}article{border:1px solid #aaa;padding:1rem;min-width:0}img{width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{overflow-wrap:anywhere}h3{overflow-wrap:anywhere}</style></head><body><h1>Screenshot and layout checks</h1><p>${report.shots.length} shots; ${report.shots.filter(shot => shot.failures.length).length} failed. <a href="report.json">JSON report</a></p><p><a href="preview/index.html">Interactive static preview</a>. Static images show the preview; integration images include Lavish chrome and its artifact iframe. Full-page and scroll captures are linked where content scrolls.</p>${groups}</body></html>\n`;
}

export async function runShots({ launch = launchBrowser, close = closeVisualResources, afterLaunch = () => {} } = {}) {
const report = { version: 2, matrix: { viewports: [{ width: 1440, height: 900 }, { width: 480, height: 900 }], colorSchemes: ['light', 'dark'], gitDiff: 'Same renderer and parser as jj; equivalent git matrix omitted' }, shots: [] };
let lavish, browser, server, interrupted = false;
const timings = {}; const started = performance.now();
const interrupt = () => { interrupted = true; browser?.close().catch(() => {}); };
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, interrupt);
const oldConfig = process.env.XDG_CONFIG_HOME;
try {
  await rm(out, { recursive: true, force: true }); await mkdir(out);
  const preview = path.join(out, 'preview');
  execFileSync(process.execPath, [path.join(root, 'scripts/preview.mjs'), preview], { stdio: 'inherit' });
  const manifest = JSON.parse(await readFile(path.join(preview, 'manifest.json'), 'utf8'));
  timings.previewSeconds = (performance.now() - started) / 1000;
  server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET') throw new Error('GET only');
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/preview/')) throw new Error('Invalid prefix');
      const file = path.resolve(preview, decodeURIComponent(url.pathname.slice('/preview/'.length)));
      if (!file.startsWith(`${preview}${path.sep}`)) throw new Error('Invalid path');
      const bytes = await readFile(file);
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html');
      res.end(bytes);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}/preview/`;
  lavish = await isolatedLavish(); process.env.XDG_CONFIG_HOME = lavish.env.XDG_CONFIG_HOME;
  const dist = path.join(lavish.dir, 'dist'); await mkdir(dist);
  execFileSync(process.execPath, [path.join(root, 'build.mjs'), root, dist]);
  const diff = await scratchDiff(lavish.dir);
  browser = await launch();
  if (await afterLaunch(browser) !== false) {
  const jobs = [];
  // PR fixtures change the shared config, so prepare all pages before concurrent captures.
  for (const variant of variants) for (const viewport of report.matrix.viewports) for (const colorScheme of report.matrix.colorSchemes) {
    if (interrupted) throw new Error('Screenshot run interrupted');
    const id = [variant.kind, variant.name, variant.view, viewport.width === 1440 ? 'wide' : 'narrow', colorScheme].filter(Boolean).join('-');
    const dir = path.join(lavish.dir, id); await mkdir(dir);
    const artifact = await makePage(variant, dir, dist, diff, lavish.env);
    jobs.push({ source: 'integration', variant, viewport, colorScheme, id: `integration-${id}`, artifact });
    const entry = manifest.pages.find(page => page.id === [variant.kind, variant.name, variant.view].filter(Boolean).join('-'));
    if (!entry) throw new Error(`Preview manifest missing ${id}`);
    jobs.push({ source: 'static', variant, viewport, colorScheme, id: `static-${id}`, url: entry.url });
  }
  const concurrency = Number(process.env.LAVISH_KIT_SHOT_JOBS || 3);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('LAVISH_KIT_SHOT_JOBS must be an integer from 1 to 8');
  timings.preparationSeconds = (performance.now() - started) / 1000 - timings.previewSeconds;
  const checksStarted = performance.now();
  async function capture({ source, variant, viewport, colorScheme, id, artifact, url }) {
    if (interrupted) throw new Error('Screenshot run interrupted');
    const context = await browser.newContext({ viewport, colorScheme }); const page = await context.newPage();
    const pageErrors = [], consoleErrors = [];
    const sanitize = text => text.replaceAll(lavish.dir, '<temp>').replace(/http:\/\/(?:localhost|127\.0\.0\.1):\d+/g, '<lavish>').replace(/\/(artifact|api|session)\/[a-f0-9]{16}/g, '/$1/<session>');
    page.on('pageerror', error => pageErrors.push(sanitize(error.message)));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(sanitize(message.text())); });
    const selected = isSelected(source, variant, viewport, colorScheme);
    const shot = { id, source, ...variant, viewport, colorScheme, selected, ...(url && { url }), ...(selected && { png: `${id}.png` }), additionalCaptures: [], checks: {} };
    try {
      if (source === 'integration') await offlineRoutes(page);
      else await page.route('**/*', route => route.request().url().startsWith(base) && route.request().method() === 'GET' ? route.continue() : route.abort());
      await page.goto(source === 'static' ? `${base}${url}?theme=${colorScheme}` : lavish.open(artifact.file));
      const frame = await ready(page, variant, artifact, source);
      if (source === 'integration') shot.checks.lavishLayout = await readLayoutIssues(page);
      const artifactScan = await scanDocument(frame), chromeScan = source === 'integration' ? await scanDocument(page.mainFrame()) : null;
      shot.checks.horizontalOverflow = artifactScan.geometry.horizontalOverflow;
      shot.checks.clippedText = artifactScan.geometry.clippedText;
      shot.checks.narrowText = artifactScan.geometry.narrowText;
      shot.checks.controls = artifactScan.geometry.controls;
      const accessibility = partitionAccessibility([{ scope: 'artifact', violations: artifactScan.accessibility }, ...(chromeScan ? [{ scope: 'chrome', violations: chromeScan.accessibility }] : [])]);
      shot.checks.accessibility = accessibility.actionable;
      shot.ignoredAccessibility = accessibility.ignored;
      if (selected) {
        await page.screenshot({ path: path.join(out, shot.png) });
        if (artifactScan.geometry.scrolls) shot.additionalCaptures = await captureScrolls(page, frame, id);
      }
      shot.checks.pageErrors = [...new Set(pageErrors)].sort();
      shot.checks.consoleErrors = [...new Set(consoleErrors)].sort();
    } catch (error) {
      shot.checks.checkerErrors = [sanitize(error.message)];
      const failurePng = `${id}-failure.png`;
      try { await page.screenshot({ path: path.join(out, failurePng) }); shot.failurePng = failurePng; } catch {}
      if (selected) delete shot.png;
    } finally { await context.close(); }
    shot.failures = failedChecks(shot.checks); report.shots.push(shot);
    console.log(`${shot.failures.length ? `FAIL ${shot.failures.join(', ')}` : 'PASS'} ${id}${shot.png ? ` shots/${shot.png}` : ''}`);
  }
  await runCaptureWorkers(jobs, concurrency, capture);
  timings.checksSeconds = (performance.now() - checksStarted) / 1000;
  report.shots.sort((a, b) => a.id.localeCompare(b.id));
  const reportErrors = validateReport(report, variants, manifest);
  if (reportErrors.length) throw new Error(reportErrors.join('; '));
  }
} catch (error) {
  report.runnerErrors = [error.message]; console.error(error.message);
} finally {
  for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, interrupt);
  const teardown = await close(browser, lavish);
  if (server?.listening) await new Promise(resolve => server.close(error => { if (error) teardown.errors.push(`Static server cleanup: ${error.message}`); resolve(); }));
  timings.totalSeconds = (performance.now() - started) / 1000;
  report.timings = timings;
  if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldConfig;
  report.cleanup = teardown.cleanup;
  if (teardown.errors.length) { report.cleanupErrors = teardown.errors; console.error(teardown.errors.join('; ')); }
}
await writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(path.join(out, 'index.html'), gallery(report));
const failed = report.shots.filter(shot => shot.failures.length).length;
console.log(`${report.shots.length} shots, ${failed} failed; shots/index.html; cleanup: ${JSON.stringify(report.cleanup || report.cleanupErrors)}`);
return failed || report.runnerErrors || report.cleanupErrors ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) process.exitCode = await runShots();
