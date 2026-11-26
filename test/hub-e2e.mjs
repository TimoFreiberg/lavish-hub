// Run: node test/hub-e2e.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { resolveWorkspace } from '../src/hub-workspace.mjs';
import { buildSelfContainedHtml } from '../vendor/lavish/src/export-bundle.js';

const exec = promisify(execFile), cli = path.resolve('bin/lavish-hub');
const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-e2e-'));
const repo = path.join(dir, 'repo'), state = path.join(dir, 'state');
let owner, ownerExit, browser, primaryError, port;
const env = { ...process.env, LAVISH_AXI_STATE_DIR: state, XDG_DATA_HOME: path.join(dir, 'data'), XDG_STATE_HOME: path.join(dir, 'xdg') };
const run = async (name, args, options = {}) => (await exec(name, args, { env, timeout: 30000, maxBuffer: 4 * 1024 * 1024, ...options })).stdout;
const until = async fn => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(100); }
  throw new Error('Hub e2e readiness timeout');
};
try {
  await mkdir(repo); await mkdir(state); await run('jj', ['git', 'init', repo]);
  await writeFile(path.join(repo, 'worker-check.js'), "const workerCheck = 'rendered change';\n");
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  port = socket.address().port; await new Promise(resolve => socket.close(resolve)); env.LAVISH_AXI_PORT = String(port);
  const identity = await resolveWorkspace(repo, env), runtime = path.join(identity.directory, 'owner', 'runtime.json');
  owner = spawn(process.execPath, [cli, 'listen', '--workspace', repo], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let ownerStdout = '', ownerStderr = '';
  owner.stdout.setEncoding('utf8'); owner.stdout.on('data', chunk => { ownerStdout += chunk; });
  owner.stderr.setEncoding('utf8'); owner.stderr.on('data', chunk => { ownerStderr += chunk; });
  ownerExit = new Promise(resolve => owner.once('exit', (code, signal) => resolve({ code, signal })));
  const record = await until(async () => { try { return JSON.parse(await readFile(runtime, 'utf8')); } catch { return null; } });
  const source = path.join(dir, 'review.html');
  await writeFile(source, '<!doctype html><title>Review</title><h1>Published hub review</h1><a href="?view=diff&amp;file=worker-check.js&amp;line=1">Open changed line</a>');
  const publishOut = await run(process.execPath, [cli, 'publish', source, '--id', 'review', '--title', 'Review', '--workspace', repo]);
  const screen = await until(() => ownerStderr.match(/ready: (https?:\/\/\S+)/) ? ownerStderr : null);
  const url = screen.match(/ready: (https?:\/\/\S+)/)[1];
  assert.ok(publishOut.includes(`${url}?view=review`), publishOut);
  browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
  const page = await browser.newPage();
  const assets = [];
  page.on('requestfinished', async request => {
    if (!/\/hub-asset-[a-f0-9]{64}\.(?:js|css)(?:\?|$)/.test(request.url())) return;
    const response = await request.response(), sizes = await request.sizes();
    assets.push({ url: request.url(), status: response.status(), headers: response.headers(), sizes });
  });
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.workerResponses = [];
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', event => window.workerResponses.push({ type: event.data.type, requestType: event.data.requestType }));
      }
    };
  });
  await page.goto(`${url}?view=review`);
  const heading = page.frameLocator('#artifact').getByRole('heading', { name: 'Published hub review' });
  await heading.waitFor({ timeout: 20000 });
  const show = page.getByRole('button', { name: 'Show anyway' }); if (await show.isVisible()) await show.click();
  if (await page.locator('#annotation').getAttribute('aria-pressed') !== 'true') await page.locator('#annotation').click();
  const box = await heading.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const rect = range.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; });
  const frameBox = await page.locator('#artifact').boundingBox(); assert.ok(frameBox);
  await page.mouse.move(frameBox.x + box.x + 2, frameBox.y + box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(frameBox.x + box.x + box.width - 2, frameBox.y + box.y + box.height / 2, { steps: 20 }); await page.mouse.up();
  const card = page.frameLocator('#artifact').locator('.lavish-annotation-card');
  await card.locator('textarea').fill('Hub e2e feedback'); await card.getByRole('button', { name: 'Queue' }).click();
  await page.getByRole('button', { name: 'Send to Agent', exact: true }).click();
  const notice = await until(() => ownerStdout.includes('Hub e2e feedback') && ownerStdout.includes('agent-notification') ? ownerStdout : null);
  const notification = notice.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).find(item => item.type === 'agent-notification' && JSON.stringify(item.prompts).includes('Hub e2e feedback'));
  assert.ok(notification, notice);
  assert.equal(notification.workspace, identity.root);
  assert.equal(notification.page, record.page);
  const canonicalSource = await realpath(source);
  assert.ok(notification.prompts.some(prompt => prompt.artifact.document === canonicalSource));
  assert.ok(notification.batchId);
  assert.equal(notification.hasDomContext, true);
  assert.equal('context' in notification, false);
  assert.equal('reply' in notification, false);
  await run(process.execPath, [cli, 'reply', '--batch', notification.batchId, 'Hub e2e reply', '--workspace', repo], { env });
  await page.getByText('Hub e2e reply', { exact: false }).first().waitFor({ timeout: 20000 });
  await page.frameLocator('#artifact').getByRole('link', { name: 'Open changed line' }).click();
  const hub = page.frameLocator('#artifact');
  await hub.locator('.hub-diff .file-header').first().waitFor({ timeout: 30000 });
  await hub.locator('.hub-diff [data-file="worker-check.js"]').waitFor({ timeout: 30000 });
  await hub.locator('.hub-diff [data-content] [data-line]').filter({ hasText: 'rendered change' }).waitFor({ timeout: 30000 });
  const hubFrame = page.frameLocator('#artifact').owner();
  let frame = await (await hubFrame.elementHandle()).contentFrame();
  await until(() => assets.filter(item => item.url.endsWith('.js')).length >= 3);
  const cold = assets.filter(item => item.url.endsWith('.js')).slice(-3).map(item => ({ ...item }));
  await hub.getByRole('button', { name: 'Review', exact: true }).click();
  await page.frameLocator('#artifact').getByRole('heading', { name: 'Published hub review' }).waitFor({ timeout: 20000 });
  const warmStart = assets.length;
  await page.frameLocator('#artifact').getByRole('link', { name: 'Diff', exact: true }).click();
  await page.frameLocator('#artifact').locator('.hub-diff .file-header').first().waitFor({ timeout: 30000 });
  await until(() => assets.slice(warmStart).filter(item => item.url.endsWith('.js')).length >= 2);
  const warm = assets.slice(warmStart).filter(item => item.url.endsWith('.js'));
  const evidence = list => list.map(({ url, status, sizes, headers }) => ({ name: new URL(url).pathname.split('/').pop(), status, sizes, cacheControl: headers['cache-control'] }));
  console.log('Chromium hub asset cold:', JSON.stringify(evidence(cold)));
  console.log('Chromium hub asset warm:', JSON.stringify(evidence(warm)));
  // Cross-document hub navigation replaces the iframe, so observe its new
  // DevTools target on a reload rather than the detached previous target.
  frame = await (await hubFrame.elementHandle()).contentFrame();
  const cdp = await page.context().newCDPSession(frame);
  await cdp.send('Network.enable');
  const network = new Map();
  cdp.on('Network.requestWillBeSent', event => {
    if (/\/hub-asset-[a-f0-9]{64}\.js$/.test(event.request.url)) network.set(event.requestId, { url: event.request.url });
  });
  cdp.on('Network.responseReceived', event => {
    const item = network.get(event.requestId);
    if (item) Object.assign(item, { status: event.response.status, diskCache: event.response.fromDiskCache });
  });
  cdp.on('Network.requestServedFromCache', event => { const item = network.get(event.requestId); if (item) item.cache = true; });
  cdp.on('Network.loadingFinished', event => { const item = network.get(event.requestId); if (item) item.transferred = event.encodedDataLength; });
  await frame.evaluate(() => location.reload());
  await hub.locator('.hub-diff .file-header').first().waitFor({ timeout: 30000 });
  await until(() => [...network.values()].filter(item => item.transferred !== undefined).length >= 2);
  const transfers = [...network.values()];
  assert.equal(transfers.length, 2);
  assert.ok(transfers.every(item => cold.some(previous => previous.url === item.url)));
  assert.equal(warm.length, 2);
  console.log('Chromium frame network:', JSON.stringify(transfers.map(({ url, ...item }) => ({ name: new URL(url).pathname.split('/').pop(), ...item }))));
  await hub.locator('.hub-diff .file-header').first().click();
  await frame.waitForFunction(() => window.workerResponses.some(response => response.type === 'success' && response.requestType === 'diff'), null, { timeout: 30000 });
  const hubHtml = await readFile(record.page, 'utf8');
  assert.ok(hubHtml.includes('globalThis.hubConfig='));
  const assetNames = [...hubHtml.matchAll(/(?:src|href)="(hub-asset-[a-f0-9]{64}\.(?:js|css))"/g)].map(match => match[1]);
  assert.equal(assetNames.length, 4);
  const diffName = hubHtml.match(/data-hub-bundle="diff" src="([^"]+)"/)[1];
  const markdownName = hubHtml.match(/data-hub-bundle="markdown" src="([^"]+)"/)[1];
  assert.ok(warm.some(item => item.url.endsWith(diffName)));
  assert.ok(warm.every(item => !item.url.endsWith(markdownName)));
  // The frame is opaque-origin, so the browser only gets bundle bytes when the
  // asset route grants this exact origin, and only for the verified bundle. The
  // two refused reads below are pages the server does serve: proving that first is
  // what makes each failure a withheld grant rather than a missing file.
  const siblingName = `document-${createHash('sha256').update(JSON.stringify(['review', canonicalSource])).digest('hex')}.html`;
  for (const url of [frame.url(), new URL(siblingName, frame.url()).href]) {
    const served = await page.request.get(url);
    assert.equal(served.status(), 200, `${new URL(url).pathname} is served`);
    assert.ok((await served.body()).length > 0, `${new URL(url).pathname} has a body`);
  }
  const crossOrigin = await frame.evaluate(async ([name, sibling]) => {
    const read = async url => {
      try { const response = await fetch(new URL(url, location.href).href, { credentials: 'omit' }); return { ok: response.ok, status: response.status, bytes: (await response.arrayBuffer()).byteLength }; }
      catch (error) { return { ok: false, error: error.message }; }
    };
    return { bundle: await read(name), page: await read('hub.html'), sibling: await read(sibling) };
  }, [diffName, siblingName]);
  assert.equal(crossOrigin.bundle.ok, true, JSON.stringify(crossOrigin));
  assert.equal(crossOrigin.bundle.bytes, (await readFile(path.join(path.dirname(record.page), diffName))).length);
  for (const [label, read] of [['the hub page', crossOrigin.page], ['a published page', crossOrigin.sibling]]) {
    assert.ok(read.error, `${label} read is refused: ${JSON.stringify(read)}`);
    assert.equal(read.status, undefined, `${label} read would expose a status if the grant were granted`);
  }
  for (const name of assetNames) {
    const assetUrl = new URL(name, frame.url()).href;
    if (name.endsWith('.js')) {
      const wire = () => new Promise((resolve, reject) => {
        const started = performance.now();
        const req = httpRequest(assetUrl, { headers: { 'accept-encoding': 'gzip' } }, response => {
          let bytes = 0; response.on('data', chunk => { bytes += chunk.length; });
          response.on('end', () => resolve({ status: response.statusCode, encoding: response.headers['content-encoding'], bytes, ms: performance.now() - started }));
          response.on('error', reject);
        });
        req.on('error', reject); req.end();
      });
      const cold = await wire(), warm = await wire();
      assert.equal(cold.status, 200); assert.equal(cold.encoding, 'gzip'); assert.equal(warm.encoding, 'gzip');
      console.log(`Hub JS identity ${(await readFile(path.join(path.dirname(record.page), name))).length} bytes; gzip ${cold.bytes} bytes; first ${cold.ms.toFixed(1)} ms, warm ${warm.ms.toFixed(1)} ms`);
    }
    const response = await page.request.get(assetUrl);
    assert.equal(response.status(), 200);
    const etag = response.headers().etag;
    assert.ok(etag);
    assert.equal((await page.request.get(assetUrl, { headers: { 'If-None-Match': etag } })).status(), 304);
  }
  const exported = await buildSelfContainedHtml(hubHtml, { baseDir: path.dirname(record.page), confineDir: path.dirname(record.page) });
  assert.deepEqual(exported.warnings, []);
  for (const name of assetNames) assert.ok(!exported.html.includes(name));
  const exportPath = path.join(dir, 'hub-export.html'); await writeFile(exportPath, exported.html);
  const offline = await browser.newContext({ offline: true });
  const offlinePage = await offline.newPage();
  const offlineErrors = []; offlinePage.on('pageerror', error => offlineErrors.push(error.message));
  await offlinePage.goto(pathToFileURL(exportPath).href);
  await offlinePage.getByText('Workspace hub', { exact: true }).waitFor();
  assert.equal(await offlinePage.evaluate(() => typeof globalThis.hubMarkdownRenderer), 'undefined');
  const resource = await offlinePage.locator('audio[data-hub-bundle="markdown"]').getAttribute('src');
  assert.match(resource, /^data:text\/javascript;base64,/);
  await offlinePage.evaluate(async () => {
    const script = document.createElement('script');
    script.src = document.querySelector('audio[data-hub-bundle="markdown"]').src;
    await new Promise((resolve, reject) => { script.onload = resolve; script.onerror = reject; document.head.append(script); });
  });
  assert.equal(await offlinePage.evaluate(() => typeof globalThis.hubMarkdownRenderer), 'function');
  assert.deepEqual(offlineErrors, []);
  const rendered = await offlinePage.evaluate(() => {
    const body = document.createElement('textarea'), preview = document.createElement('div');
    body.value = '# Offline renderer check\n\nA **bold** result.';
    globalThis.hubMarkdownRenderer(body, preview)();
    return { heading: preview.querySelector('h1')?.textContent, bold: preview.querySelector('strong')?.textContent };
  });
  assert.deepEqual(rendered, { heading: 'Offline renderer check #', bold: 'bold' });
  await offline.close();
  const mocked = await browser.newContext();
  const exportPage = await mocked.newPage();
  const exportErrors = []; exportPage.on('pageerror', error => exportErrors.push(error.message));
  const operations = []; let selected = 'diff';
  await exportPage.route('**/action', async route => {
    const request = route.request();
    if (request.method() !== 'POST') { await route.abort(); return; }
    const { operation, id } = request.postDataJSON(); operations.push({ operation, id });
    let result;
    if (operation === 'status') result = { available: true, selected };
    else if (operation === 'documents') result = { documents: [] };
    else if (operation === 'snapshot') result = { base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [], patch: '' };
    else if (operation === 'navigate') { selected = id; result = { selected }; }
    else if (operation === 'readDocument' && id === 'tasks') result = { text: '# Exported tasks\n\nA **lazy** renderer.', hash: 'one', version: 'one' };
    else { await route.abort(); return; }
    await route.fulfill({ json: { result }, headers: { 'access-control-allow-origin': '*' } });
  });
  await exportPage.goto(pathToFileURL(exportPath).href);
  await exportPage.getByText('No commits in this range.').waitFor({ timeout: 10000 });
  assert.equal(await exportPage.evaluate(() => typeof globalThis.hubMarkdownRenderer), 'undefined');
  await exportPage.getByRole('button', { name: 'Tasks', exact: true }).click();
  await exportPage.locator('.hub-markdown h1').filter({ hasText: 'Exported tasks' }).waitFor({ timeout: 10000 });
  assert.equal(await exportPage.locator('.hub-markdown strong').textContent(), 'lazy');
  assert.equal(await exportPage.evaluate(() => typeof globalThis.hubMarkdownRenderer), 'function');
  assert.ok(operations.some(item => item.operation === 'readDocument' && item.id === 'tasks'));
  assert.deepEqual(exportErrors, []);
  await mocked.close();
  const markdown = path.join(dir, 'notes.md');
  await writeFile(markdown, '# Original\n\n[Open file](?view=diff&file=worker-check.js&line=1)\n');
  await run(process.execPath, [cli, 'publish', markdown, '--id', 'notes', '--workspace', repo]);
  await page.frameLocator('#artifact').getByRole('button', { name: 'notes.md', exact: true }).click({ timeout: 20000 });
  await page.frameLocator('#artifact').locator('.hub-markdown h1').filter({ hasText: 'Original' }).waitFor({ timeout: 20000 });
  if (await page.locator('#annotation').getAttribute('aria-pressed') !== 'true') await page.locator('#annotation').click();
  await page.frameLocator('#artifact').getByRole('link', { name: 'Open file' }).click();
  await page.frameLocator('#artifact').locator('.hub-diff [data-file="worker-check.js"]').waitFor({ timeout: 20000 });
  await page.frameLocator('#artifact').getByRole('button', { name: 'notes.md', exact: true }).click();
  await page.frameLocator('#artifact').getByRole('button', { name: 'Edit Document Markdown' }).click();
  const editor = page.frameLocator('#artifact').getByRole('textbox', { name: 'Document Markdown' });
  await editor.waitFor({ timeout: 20000 });
  await editor.fill('# Edited in e2e\n');
  await page.frameLocator('#artifact').getByRole('button', { name: 'Save', exact: true }).click();
  await until(async () => (await readFile(markdown, 'utf8')) === '# Edited in e2e\n');
  await page.goto(`${url}?view=diff&file=worker-check.js&line=1`);
  await page.frameLocator('#artifact').locator('.hub-diff [data-file="worker-check.js"]').waitFor({ timeout: 20000 });
  await page.frameLocator('#artifact').locator('.hub-diff [data-line="1"][data-selected-line]').first().waitFor({ timeout: 20000 });
  assert.equal(new URL(page.url()).searchParams.has('file'), false);
  assert.equal(new URL(page.url()).searchParams.has('line'), false);
  const changeId = (await run('jj', ['log', '-r', '@', '--no-graph', '-T', 'change_id'], { cwd: repo })).trim();
  await page.goto(`${url}?view=diff&change=${changeId.slice(0, 12)}`);
  await page.frameLocator('#artifact').locator(`.rail-row[data-change-id="${changeId}"].deep-link-highlight`).waitFor({ timeout: 20000 });
  await run(process.execPath, [cli, 'stop', '--workspace', repo]);
  await until(async () => { try { await readFile(runtime); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } });
  await ownerExit;
  console.log('PASS: hub owner received scoped annotation and browser displayed reply; owner stopped');
} catch (error) { primaryError = error; }
finally {
  const errors = [];
  try { await browser?.close(); } catch (error) { errors.push(error); }
  if (owner && owner.exitCode === null && owner.signalCode === null) {
    try { owner.kill('SIGTERM'); } catch {}
    await Promise.race([ownerExit, delay(5000)]);
    if (owner.exitCode === null && owner.signalCode === null) {
      try { owner.kill('SIGKILL'); } catch {}
      await Promise.race([ownerExit, delay(2000)]);
    }
  }
  if (port) { try { await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) }); } catch {} }
  if (!errors.length) {
    try { await rm(dir, { recursive: true, force: true }); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) {
    const cleanupError = new AggregateError(errors, `Cleanup failed; scratch evidence retained at ${dir}`);
    if (primaryError) throw new AggregateError([primaryError, cleanupError], 'E2E and cleanup failed');
    throw cleanupError;
  }
}
if (primaryError) throw primaryError;
