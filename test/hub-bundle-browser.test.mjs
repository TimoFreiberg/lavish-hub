import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createHubTransport } from '../src/hub-transport.mjs';
import { buildSelfContainedHtml } from '../vendor/lavish/src/export-bundle.js';

// Renderer bundles load over the network, so their cancellation has to be tested
// against a real socket: a removed element leaves its request running, and only a
// server that keeps the response open can tell an abort from a late answer.
const app = (await readFile(new URL('../web/hub-lifecycle.js', import.meta.url), 'utf8')) + '\n' + (await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8'));
const markdownBundle = 'globalThis.hubMarkdownRenderer = () => () => {};';
const diffBundle = 'globalThis.mountLavishDiff = () => ({ hide() {}, update() {} });';

async function bundleServer(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

// Bundle loads are cross-origin: the hub page runs in Lavish's opaque-origin
// artifact frame, so the asset route answers with `Access-Control-Allow-Origin:
// null`. These servers stand in for it.
const cors = { 'access-control-allow-origin': 'null' };
const send = (res, body) => { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', ...cors }); res.end(body); };

async function openPage(t, transport, bundles) {
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const audio = Object.entries(bundles).map(([name, src]) => `<audio preload="none" data-hub-bundle="${name}" src="${src}"></audio>`).join('');
  // The bundle deadline is shortened so a stalled response fails inside a test,
  // while the code keeps its real timeout for production. The shortened value
  // stays well above a local round trip, so only a response that never arrives
  // trips it and a slow but healthy load is not read as a failure.
  await page.setContent(`<div id="app"></div><script>const nativeTimeout = window.setTimeout; window.setTimeout = (fn, ms, ...rest) => nativeTimeout(fn, ms === 10000 ? 750 : ms, ...rest); globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script>${audio}<script type="module">${app}</script>`);
  return page;
}

const actionTransport = (overrides = {}) => createHubTransport({
  status: () => ({ available: true, selected: 'commits' }), documents: () => ({ documents: [] }),
  snapshot: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [], patch: '' }),
  navigate: () => ({}), readDocument: () => ({ text: 'Tasks', hash: 'one', version: 'one' }),
  ...overrides,
});

test('a bundle that never answers is aborted and the same URL retries', { timeout: 30000 }, async t => {
  let requests = 0, closed = 0, origins = [];
  const asset = await bundleServer((req, res) => {
    requests++; origins.push(req.headers.origin);
    if (requests === 1) { res.on('close', () => { closed++; }); return; }
    send(res, markdownBundle);
  });
  t.after(() => asset.close());
  const transport = await actionTransport();
  t.after(() => transport.close());
  const page = await openPage(t, transport, { markdown: `${asset.origin}/markdown.js` });
  await page.getByText('No commits in this range.').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByText('Could not load markdown renderer').waitFor({ timeout: 5000 });
  assert.equal(requests, 1);
  assert.equal(closed, 1, 'the abandoned request reaches the server and its socket closes');
  assert.deepEqual(origins, ['null'], 'the bundle is fetched from the opaque-origin frame');
  assert.equal(await page.evaluate(() => typeof globalThis.hubMarkdownRenderer), 'undefined');
  assert.equal(await page.locator(`head script[src="${asset.origin}/markdown.js"]`).count(), 0);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Tasks Markdown' }).waitFor({ timeout: 5000 });
  assert.equal(requests, 2, 'the retry asks the server for the same URL again');
  assert.equal(await page.evaluate(() => typeof globalThis.hubMarkdownRenderer), 'function');
  assert.equal(await page.locator('head script[src^="blob:"]').count(), 0, 'the executed bundle is cleaned up');
});

test('a stalled bundle body is aborted before it can execute', { timeout: 30000 }, async t => {
  let requests = 0, closed = 0;
  const asset = await bundleServer((req, res) => {
    requests++;
    if (requests > 1) { send(res, markdownBundle); return; }
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', ...cors });
    res.write('globalThis.partialBundle = true;\n');
    res.on('close', () => { closed++; });
  });
  t.after(() => asset.close());
  const transport = await actionTransport();
  t.after(() => transport.close());
  const page = await openPage(t, transport, { markdown: `${asset.origin}/markdown.js` });
  await page.getByText('No commits in this range.').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByText('Could not load markdown renderer').waitFor({ timeout: 5000 });
  assert.equal(closed, 1, 'the stalled body is cancelled rather than left reading');
  assert.equal(await page.evaluate(() => typeof globalThis.partialBundle), 'undefined', 'no part of a partial body runs');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Tasks Markdown' }).waitFor({ timeout: 5000 });
  assert.equal(requests, 2);
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => typeof globalThis.partialBundle), 'undefined');
  assert.equal(await page.evaluate(() => typeof globalThis.hubMarkdownRenderer), 'function');
});

test('bundles load on demand, reuse a successful load, and retry a failure', { timeout: 30000 }, async t => {
  let markdown = 0, diff = 0;
  const asset = await bundleServer((req, res) => {
    if (req.url.startsWith('/diff')) { diff++; send(res, diffBundle); return; }
    markdown++;
    if (markdown === 1) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('unavailable'); return; }
    send(res, markdownBundle);
  });
  t.after(() => asset.close());
  let selected = 'commits';
  const transport = await createHubTransport({
    status: () => ({ available: true, selected }), documents: () => ({ documents: [] }),
    snapshot: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [], patch: '' }),
    navigate: ({ id }) => { selected = id; return { selected }; },
    readDocument: () => ({ text: 'Tasks', hash: 'one', version: 'one' }),
  });
  t.after(() => transport.close());
  const page = await openPage(t, transport, { diff: `${asset.origin}/diff.js`, markdown: `${asset.origin}/markdown.js` });
  await page.getByText('No commits in this range.').waitFor({ timeout: 5000 });
  assert.deepEqual([diff, markdown], [0, 0]);
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await page.locator('.hub-diff').waitFor({ state: 'attached', timeout: 5000 });
  assert.equal(diff, 1);
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByText('Could not load markdown renderer').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Tasks Markdown' }).waitFor({ timeout: 5000 });
  assert.ok(markdown >= 2, `the failed renderer was requested again (${markdown})`);
  assert.equal(await page.locator('.hub-diff').count(), 0, 'the document view is not left holding the diff view');
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await page.locator('.hub-diff').waitFor({ state: 'attached', timeout: 5000 });
  assert.equal(diff, 1, 'a loaded renderer is not fetched again');
});

test('a bundle that never defines the renderer is removed and can be retried', { timeout: 30000 }, async t => {
  let requests = 0;
  const asset = await bundleServer((_req, res) => {
    requests++;
    send(res, requests === 1 ? 'globalThis.somethingElse = true;' : markdownBundle);
  });
  t.after(() => asset.close());
  const transport = await actionTransport();
  t.after(() => transport.close());
  const page = await openPage(t, transport, { markdown: `${asset.origin}/markdown.js` });
  await page.getByText('No commits in this range.').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByText('Invalid markdown renderer').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('head script[src^="blob:"]').count(), 0, 'a renderer that defines nothing leaves no element behind');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Tasks Markdown' }).waitFor({ timeout: 5000 });
  assert.equal(requests, 2);
});

test('a bundle served with a non-script type is refused', { timeout: 30000 }, async t => {
  let requests = 0;
  const asset = await bundleServer((_req, res) => {
    requests++;
    if (requests === 1) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...cors }); res.end('<p>Not a bundle</p>'); return; }
    send(res, markdownBundle);
  });
  t.after(() => asset.close());
  const transport = await actionTransport();
  t.after(() => transport.close());
  const page = await openPage(t, transport, { markdown: `${asset.origin}/markdown.js` });
  await page.getByText('No commits in this range.').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByText('Could not load markdown renderer').waitFor({ timeout: 5000 });
  assert.equal(await page.evaluate(() => typeof globalThis.hubMarkdownRenderer), 'undefined');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Tasks Markdown' }).waitFor({ timeout: 5000 });
});

test('a bundle address that is neither fetchable nor offline is refused', { timeout: 30000 }, async t => {
  const transport = await actionTransport();
  t.after(() => transport.close());
  const page = await openPage(t, transport, { markdown: 'ftp://assets.invalid/markdown.js' });
  await page.getByText('No commits in this range.').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByText('Could not load markdown renderer').waitFor({ timeout: 5000 });
  assert.equal(await page.evaluate(() => typeof globalThis.hubMarkdownRenderer), 'undefined');
  assert.equal(await page.locator('head script[src]').count(), 0, 'an address no page produces is not appended either');
});

test('an exported page loads its inlined renderer without fetching it', { timeout: 30000 }, async t => {
  const transport = await actionTransport();
  t.after(() => transport.close());
  const markdown = 'globalThis.hubMarkdownRenderer = () => () => {};';
  const html = `<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><audio preload="none" data-hub-bundle="markdown" src="markdown.js"></audio><script>${app}</script>`;
  const exported = await buildSelfContainedHtml(html, { baseDir: '/art', readLocalFile: async () => Buffer.from(markdown) });
  assert.deepEqual(exported.warnings, []);
  assert.ok(exported.html.includes('src="data:text/javascript;base64,'));
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requested = [];
  page.on('request', request => { if (!request.url().startsWith('data:')) requested.push(request.url()); });
  await page.setContent(exported.html);
  await page.getByText('No commits in this range.').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Tasks Markdown' }).waitFor({ timeout: 5000 });
  assert.equal(await page.evaluate(() => typeof globalThis.hubMarkdownRenderer), 'function');
  assert.ok(!requested.some(url => url.endsWith('/markdown.js')), `the inlined renderer is not fetched (${requested})`);
});

test('a renderer request and its document read start independently', { timeout: 30000 }, async t => {
  let releaseBundle, bundleStarted = 0, reads = 0;
  const bundleGate = new Promise(resolve => { releaseBundle = resolve; });
  const asset = await bundleServer(async (_req, res) => {
    bundleStarted++;
    await bundleGate;
    send(res, markdownBundle);
  });
  t.after(() => asset.close());
  const transport = await createHubTransport({
    status: () => ({ available: true, selected: 'commits' }), documents: () => ({ documents: [] }),
    snapshot: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [], patch: '' }),
    navigate: () => ({}), readDocument: async () => { reads++; return { text: 'Tasks', hash: 'one', version: 'one' }; },
  });
  t.after(() => transport.close());
  const page = await openPage(t, transport, { markdown: `${asset.origin}/markdown.js` });
  await page.getByText('No commits in this range.').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  for (let i = 0; i < 100 && !(bundleStarted && reads); i++) await page.waitForTimeout(50);
  assert.equal(bundleStarted, 1);
  assert.equal(reads, 1);
  assert.equal(await page.getByRole('button', { name: 'Edit Tasks Markdown' }).count(), 0);
  releaseBundle();
  await page.getByRole('button', { name: 'Edit Tasks Markdown' }).waitFor({ timeout: 5000 });
});
