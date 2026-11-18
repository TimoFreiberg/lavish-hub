// Run with a working hc service: node test/hub-e2e.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
import { cleanupTerminals } from './hub-e2e-cleanup.mjs';
import { buildSelfContainedHtml } from '../vendor/lavish/src/export-bundle.js';

const exec = promisify(execFile), cli = path.resolve('bin/lavish-kit');
const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-hc-e2e-'));
const repo = path.join(dir, 'repo'), state = path.join(dir, 'state');
const terminals = []; let browser, primaryError, port;
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
  const variables = ['LAVISH_AXI_STATE_DIR', 'LAVISH_AXI_PORT', 'XDG_DATA_HOME', 'XDG_STATE_HOME'].map(key => `${key}=${env[key]}`);
  const result = JSON.parse(await run('hc', ['run', '--bg', '--no-parent', '--no-notify', '--json', '--cwd', repo, 'env', ...variables, process.execPath, cli, 'hub', 'listen', '--workspace', repo]));
  assert.ok(result.address); terminals.push(result.address);
  const record = await until(async () => { try { return JSON.parse(await readFile(runtime, 'utf8')); } catch { return null; } });
  const source = path.join(dir, 'review.html');
  await writeFile(source, '<!doctype html><title>Review</title><h1>Published hub review</h1>');
  await run(process.execPath, [cli, 'hub', 'publish', source, '--id', 'review', '--title', 'Review', '--workspace', repo]);
  const screen = await until(async () => { const text = await run('hc', ['read', result.address]); return text.match(/ready: (https?:\/\/\S+)/) ? text : null; });
  const url = screen.match(/ready: (https?:\/\/\S+)/)[1];
  browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
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
  await page.goto(url);
  const heading = page.frameLocator('#artifact').getByRole('heading', { name: 'Published hub review' });
  await heading.waitFor({ timeout: 20000 });
  const show = page.getByRole('button', { name: 'Show anyway' }); if (await show.isVisible()) await show.click();
  if (await page.locator('#annotation').getAttribute('aria-pressed') !== 'true') await page.locator('#annotation').click();
  const box = await heading.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const rect = range.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; });
  const frameBox = await page.locator('#artifact').boundingBox(); assert.ok(frameBox);
  await page.mouse.move(frameBox.x + box.x + 2, frameBox.y + box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(frameBox.x + box.x + box.width - 2, frameBox.y + box.y + box.height / 2, { steps: 20 }); await page.mouse.up();
  const card = page.frameLocator('#artifact').locator('.lavish-annotation-card');
  await card.locator('textarea').fill('Hub hc feedback'); await card.getByRole('button', { name: 'Queue' }).click();
  await page.getByRole('button', { name: 'Send to Agent', exact: true }).click();
  const notice = await until(async () => { const text = await run('hc', ['read', result.address]); return text.includes('Hub hc feedback') && text.includes('agent-notification') ? text : null; });
  const notification = notice.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).find(item => item.type === 'agent-notification' && JSON.stringify(item.prompts).includes('Hub hc feedback'));
  assert.ok(notification, notice);
  assert.equal(notification.workspace, identity.root);
  assert.equal(notification.page, record.page);
  const canonicalSource = await realpath(source);
  assert.equal(notification.snapshotDocument, canonicalSource);
  assert.ok(notification.snapshotPage);
  assert.ok(notification.prompts.some(prompt => prompt.document === canonicalSource && prompt.page === notification.snapshotPage));
  assert.match(notification.reply, /^lavish-kit reply /);
  const command = notification.reply.replace("'...'", "'Hub hc reply'");
  assert.notEqual(command, notification.reply);
  await run('/bin/sh', ['-c', command], { env: { ...env, PATH: `${path.dirname(cli)}${path.delimiter}${env.PATH}` } });
  await page.getByText('Hub hc reply', { exact: false }).first().waitFor({ timeout: 20000 });
  await page.frameLocator('#artifact').getByRole('link', { name: 'Changes', exact: true }).click();
  const hub = page.frameLocator('#artifact');
  await hub.locator('.hub-diff .sidebar').getByRole('heading', { name: 'Files (1)' }).waitFor({ timeout: 30000 });
  await hub.locator('.hub-diff [data-file="worker-check.js"]').waitFor({ timeout: 30000 });
  await hub.locator('.hub-diff [data-content] [data-line]').filter({ hasText: 'rendered change' }).waitFor({ timeout: 30000 });
  const hubFrame = page.frameLocator('#artifact').owner();
  const frame = await (await hubFrame.elementHandle()).contentFrame();
  await until(() => assets.filter(item => item.url.endsWith('.js')).length >= 3);
  const cold = assets.filter(item => item.url.endsWith('.js')).slice(-3).map(item => ({ ...item }));
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
  await hub.getByRole('button', { name: 'Review', exact: true }).click();
  await page.frameLocator('#artifact').getByRole('heading', { name: 'Published hub review' }).waitFor({ timeout: 20000 });
  const warmStart = assets.length;
  await page.frameLocator('#artifact').getByRole('link', { name: 'Changes', exact: true }).click();
  await page.frameLocator('#artifact').locator('.hub-diff .sidebar').getByRole('heading', { name: 'Files (1)' }).waitFor({ timeout: 30000 });
  await until(() => assets.slice(warmStart).filter(item => item.url.endsWith('.js')).length >= 2);
  const warm = assets.slice(warmStart).filter(item => item.url.endsWith('.js'));
  const evidence = list => list.map(({ url, status, sizes, headers }) => ({ name: new URL(url).pathname.split('/').pop(), status, sizes, cacheControl: headers['cache-control'] }));
  console.log('Chromium hub asset cold:', JSON.stringify(evidence(cold)));
  console.log('Chromium hub asset warm:', JSON.stringify(evidence(warm)));
  await until(() => [...network.values()].filter(item => item.transferred !== undefined).length >= 2);
  const transfers = [...network.values()];
  assert.equal(transfers.length, 2);
  assert.ok(transfers.every(item => cold.some(previous => previous.url === item.url)));
  assert.equal(warm.length, 2);
  console.log('Chromium frame network:', JSON.stringify(transfers.map(({ url, ...item }) => ({ name: new URL(url).pathname.split('/').pop(), ...item }))));
  await frame.waitForFunction(() => window.workerResponses.some(response => response.type === 'success' && response.requestType === 'diff'), null, { timeout: 30000 });
  const hubHtml = await readFile(record.page, 'utf8');
  assert.ok(hubHtml.includes('globalThis.hubConfig='));
  const assetNames = [...hubHtml.matchAll(/(?:src|href)="(hub-asset-[a-f0-9]{64}\.(?:js|css))"/g)].map(match => match[1]);
  assert.equal(assetNames.length, 4);
  const diffName = hubHtml.match(/data-hub-bundle="diff" src="([^"]+)"/)[1];
  const markdownName = hubHtml.match(/data-hub-bundle="markdown" src="([^"]+)"/)[1];
  assert.ok(warm.some(item => item.url.endsWith(diffName)));
  assert.ok(warm.every(item => !item.url.endsWith(markdownName)));
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
  const offlinePage = await offline.newPage(); await offlinePage.goto(pathToFileURL(exportPath).href);
  await offlinePage.getByText('Workspace hub', { exact: true }).waitFor();
  assert.equal(await offlinePage.evaluate(() => typeof globalThis.hubMarkdownRenderer), 'undefined');
  await offlinePage.getByRole('button', { name: 'Tasks', exact: true }).click();
  await offlinePage.waitForFunction(() => typeof globalThis.hubMarkdownRenderer === 'function');
  const rendered = await offlinePage.evaluate(() => {
    const body = document.createElement('textarea'), preview = document.createElement('div');
    body.value = '# Offline renderer check\n\nA **bold** result.';
    globalThis.hubMarkdownRenderer(body, preview)();
    return { heading: preview.querySelector('h1')?.textContent, bold: preview.querySelector('strong')?.textContent };
  });
  assert.deepEqual(rendered, { heading: 'Offline renderer check #', bold: 'bold' });
  await offline.close();
  const markdown = path.join(dir, 'notes.md');
  await writeFile(markdown, '# Original\n');
  await run(process.execPath, [cli, 'hub', 'publish', markdown, '--id', 'notes', '--workspace', repo]);
  await page.frameLocator('#artifact').getByRole('button', { name: 'notes.md', exact: true }).click({ timeout: 20000 });
  await page.frameLocator('#artifact').locator('.hub-markdown h1').filter({ hasText: 'Original' }).waitFor({ timeout: 20000 });
  await page.frameLocator('#artifact').getByRole('button', { name: 'Edit Document Markdown' }).click();
  const editor = page.frameLocator('#artifact').getByRole('textbox', { name: 'Document Markdown' });
  await editor.waitFor({ timeout: 20000 });
  await editor.fill('# Edited in hc\n');
  await page.frameLocator('#artifact').getByRole('button', { name: 'Save', exact: true }).click();
  await until(async () => (await readFile(markdown, 'utf8')) === '# Edited in hc\n');
  await run(process.execPath, [cli, 'hub', 'stop', '--workspace', repo]);
  await until(async () => { try { await readFile(runtime); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } });
  console.log('PASS: hc owner received scoped annotation and browser displayed reply; owner stopped');
} catch (error) { primaryError = error; }
finally {
  const errors = [];
  try { await browser?.close(); } catch (error) { errors.push(error); }
  if (port) { try { await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) }); } catch {} }
  try { await cleanupTerminals({ journal: path.join(dir, 'terminal.json'), terminals, dir, run, errors }); }
  catch (error) { if (primaryError) throw new AggregateError([primaryError, error], 'E2E and cleanup failed'); throw error; }
}
if (primaryError) throw primaryError;
