import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createHubTransport } from '../src/hub-transport.mjs';
import { build } from 'esbuild';
import { themeCss } from '../src/orangebox.mjs';
import { buildSelfContainedHtml } from '../vendor/lavish/src/export-bundle.js';

test('navigation renders before snapshot and serializes delayed owner updates', { timeout: 30000 }, async t => {
  let releaseSnapshot, releaseNavigation;
  const snapshotGate = new Promise(resolve => { releaseSnapshot = resolve; });
  const navigationGate = new Promise(resolve => { releaseNavigation = resolve; });
  let selected = 'commits';
  const navigations = [];
  const transport = await createHubTransport({
    status: () => ({ available: true, selected }), documents: () => ({ documents: [] }),
    snapshot: async () => { await snapshotGate; return { base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [] }; },
    navigate: async ({ id }) => { navigations.push(id); if (navigations.length === 1) await navigationGate; selected = id; return { selected }; },
    readDocument: () => ({ text: 'Tasks', hash: 'one', version: 'one' }),
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { releaseSnapshot(); releaseNavigation(); await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const markdown = (await build({ entryPoints: ['web/hub-markdown.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser' })).outputFiles[0].text;
  const page = await browser.newPage();
  await page.setContent(`<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><script>${markdown.replaceAll('</script', '<\\/script')}</script><script type="module">${script}</script>`);
  await page.getByText('Loading repository snapshot…').waitFor({ timeout: 3000 });
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('heading', { name: 'Tasks' }).waitFor({ timeout: 3000 });
  await page.getByRole('button', { name: 'Commits', exact: true }).click();
  await page.getByRole('heading', { name: 'Commits' }).waitFor({ timeout: 3000 });
  assert.deepEqual(navigations, ['tasks']);
  releaseNavigation();
  await assertEventually(() => assert.deepEqual(navigations, ['tasks', 'commits']));
  releaseSnapshot();
  await page.getByText('No commits in this range.').waitFor({ timeout: 3000 });
  assert.equal(selected, 'commits');
});

test('cross-page navigation pauses pending refresh and resumes after failure', { timeout: 30000 }, async t => {
  let releaseStatus, releaseNavigation, statusCalls = 0, snapshots = 0, navigations = 0;
  const statusGate = new Promise(resolve => { releaseStatus = resolve; });
  const navigationGate = new Promise(resolve => { releaseNavigation = resolve; });
  const transport = await createHubTransport({
    status: async () => { if (++statusCalls === 2) await statusGate; return { available: true, selected: 'commits' }; },
    documents: () => ({ documents: [{ id: 'published', title: 'Published', source: 'index.html', sibling: 'published.html' }] }),
    snapshot: () => { snapshots++; return { base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [] }; },
    navigate: async () => { navigations++; await navigationGate; throw new Error('navigation failed'); },
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { releaseStatus(); releaseNavigation(); await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const page = await browser.newPage();
  await page.setContent(`<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><script type="module">${script}</script>`);
  await page.getByText('No commits in this range.').waitFor();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await assertEventually(() => assert.equal(statusCalls, 2));
  await page.getByRole('button', { name: 'Published' }).click();
  await assertEventually(() => assert.equal(navigations, 1));
  releaseStatus();
  await page.waitForTimeout(2200);
  assert.equal(snapshots, 1); assert.equal(statusCalls, 2);
  releaseNavigation();
  await assertEventually(() => assert.ok(statusCalls >= 3));
  await assertEventually(() => assert.ok(snapshots >= 2));
  assert.equal(await page.locator('#connection').textContent(), 'navigation failed');
  assert.equal(navigations, 1);
});

test('new selection wins while remote navigation waits for annotation mode', { timeout: 30000 }, async t => {
  let selected = 'commits', statusCalls = 0;
  const transport = await createHubTransport({
    status: () => { statusCalls++; return { available: true, selected }; },
    documents: () => ({ documents: [{ id: 'published', title: 'Published', source: 'index.html', sibling: 'published.html' }] }),
    snapshot: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [] }),
    navigate: ({ id }) => { selected = id; return { selected }; },
    readDocument: () => ({ text: 'Tasks', hash: 'one', version: 'one' }),
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const markdown = (await build({ entryPoints: ['web/hub-markdown.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser' })).outputFiles[0].text;
  const page = await browser.newPage();
  await page.setContent(`<div id="app"></div><script>globalThis.lavish={setAnnotationMode(value){if(value&&!globalThis.releaseMode)return new Promise(resolve=>{globalThis.releaseMode=resolve})}};globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><script>${markdown.replaceAll('</script', '<\\/script')}</script><script type="module">${script}</script>`);
  await page.getByText('No commits in this range.').waitFor();
  selected = 'published';
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.waitForFunction(() => typeof globalThis.releaseMode === 'function');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Tasks Markdown' }).waitFor();
  const before = statusCalls;
  await page.evaluate(() => globalThis.releaseMode());
  await assertEventually(() => assert.ok(statusCalls > before));
  assert.equal(await page.locator('#view h1').textContent(), 'Tasks');
});

test('older remote navigation cannot resume polling during a newer cross-page selection', { timeout: 30000 }, async t => {
  let selected = 'commits', statusCalls = 0, navigations = 0, releaseNavigation;
  const navigationGate = new Promise(resolve => { releaseNavigation = resolve; });
  const transport = await createHubTransport({
    status: () => { statusCalls++; return { available: true, selected }; },
    documents: () => ({ documents: [
      { id: 'first', title: 'First', source: 'first.html', sibling: 'first.html' },
      { id: 'second', title: 'Second', source: 'second.html', sibling: 'second.html' },
    ] }),
    snapshot: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [] }),
    navigate: async () => { navigations++; await navigationGate; selected = 'commits'; throw new Error('navigation failed'); },
    readDocument: () => ({ text: '', hash: 'one', version: 'one' }),
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { releaseNavigation(); await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const page = await browser.newPage();
  await page.setContent(`<div id="app"></div><script>globalThis.lavish={setAnnotationMode(value){if(value)return new Promise(resolve=>{globalThis.releaseMode=resolve})}};globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><script type="module">${script}</script>`);
  await page.getByText('No commits in this range.').waitFor();
  selected = 'first';
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.waitForFunction(() => typeof globalThis.releaseMode === 'function');
  await page.getByRole('button', { name: 'Second', exact: true }).click();
  await assertEventually(() => assert.equal(navigations, 1));
  const before = statusCalls;
  await page.evaluate(() => globalThis.releaseMode());
  await page.waitForTimeout(2200);
  assert.equal(statusCalls, before, 'polling remains paused while the newer navigation is pending');
  releaseNavigation();
  await assertEventually(() => assert.ok(statusCalls > before));
  assert.equal(await page.locator('#connection').textContent(), 'navigation failed');
});

test('document failure does not also display a renderer failure', { timeout: 30000 }, async t => {
  let releaseRead;
  const gate = new Promise(resolve => { releaseRead = resolve; });
  const transport = await createHubTransport({
    status: () => ({ available: true, selected: 'commits' }), documents: () => ({ documents: [] }),
    snapshot: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [] }),
    navigate: () => ({}), readDocument: async () => { await gate; throw new Error('Document unavailable'); },
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { releaseRead(); await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const page = await browser.newPage();
  await page.setContent(`<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><script type="module">${script}</script>`);
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(await page.getByText('Missing markdown renderer').count(), 0);
  releaseRead();
  await page.getByText('Document unavailable').waitFor();
  assert.equal(await page.getByText('Missing markdown renderer').count(), 0);
});

test('Markdown bundle and document read start independently', { timeout: 30000 }, async t => {
  let releaseRead, reads = 0, bundles = 0;
  const gate = new Promise(resolve => { releaseRead = resolve; });
  const transport = await createHubTransport({
    status: () => ({ available: true, selected: 'commits' }), documents: () => ({ documents: [] }),
    snapshot: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [] }),
    navigate: () => ({}), readDocument: async () => { reads++; await gate; return { text: 'Tasks', hash: 'one', version: 'one' }; },
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { releaseRead(); await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const page = await browser.newPage();
  await page.exposeFunction('recordBundle', () => { bundles++; });
  await page.setContent(`<div id="app"></div><script>const append = document.head.append.bind(document.head); document.head.append = node => { if (node.src?.startsWith('http://assets.test/')) { recordBundle(); globalThis.hubMarkdownRenderer = () => () => {}; queueMicrotask(() => node.onload()); } else append(node); }; globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><audio preload="none" data-hub-bundle="markdown" src="http://assets.test/markdown.js"></audio><script type="module">${script}</script>`);
  await page.getByText('No commits in this range.').waitFor();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await assertEventually(() => { assert.equal(reads, 1); assert.equal(bundles, 1); });
  releaseRead();
  await page.getByRole('button', { name: 'Edit Tasks Markdown' }).waitFor();
});

test('exported renderer loads on demand from an inlined resource', { timeout: 30000 }, async t => {
  const transport = await createHubTransport({
    status: () => ({ available: true, selected: 'commits' }), documents: () => ({ documents: [] }),
    snapshot: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [] }),
    navigate: () => ({}), readDocument: () => ({ text: '# Offline', hash: 'one', version: 'one' }),
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const app = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const markdown = (await build({ entryPoints: ['web/hub-markdown.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser' })).outputFiles[0].text;
  const html = `<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><audio preload="none" data-hub-bundle="markdown" src="markdown.js"></audio><script>${app}</script>`;
  const exported = await buildSelfContainedHtml(html, { baseDir: '/art', readLocalFile: async () => Buffer.from(markdown) });
  assert.deepEqual(exported.warnings, []);
  assert.ok(exported.html.includes('src="data:text/javascript;base64,'));
  const page = await browser.newPage();
  await page.setContent(exported.html);
  await page.getByText('No commits in this range.').waitFor();
  assert.equal(await page.evaluate(() => typeof globalThis.hubMarkdownRenderer), 'undefined');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.locator('.hub-markdown h1').filter({ hasText: 'Offline' }).waitFor();
  assert.equal(await page.evaluate(() => typeof globalThis.hubMarkdownRenderer), 'function');
});

test('bundles load only on demand, retry failures and reuse successful loads', { timeout: 30000 }, async t => {
  let selected = 'commits', markdownRequests = 0, diffRequests = 0;
  const transport = await createHubTransport({
    status: () => ({ available: true, selected }), documents: () => ({ documents: [] }),
    snapshot: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [], patch: '' }),
    navigate: ({ id }) => { selected = id; return { selected }; },
    readDocument: () => ({ text: 'Tasks', hash: 'one', version: 'one' }),
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const page = await browser.newPage();
  await page.exposeFunction('recordBundle', name => { if (name === 'diff') diffRequests++; else markdownRequests++; });
  await page.setContent(`<div id="app"></div><script>const append = document.head.append.bind(document.head); let md = 0; document.head.append = node => { if (node.src?.startsWith('http://assets.test/')) { const name = node.src.includes('diff.js') ? 'diff' : 'markdown'; recordBundle(name); if (name === 'diff') globalThis.finishDiff = () => { globalThis.mountLavishDiff = () => ({ hide() {}, update() {} }); node.onload(); }; else if (++md === 1) queueMicrotask(() => node.onerror()); else { globalThis.hubMarkdownRenderer = () => () => {}; queueMicrotask(() => node.onload()); } } else append(node); }; globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><audio preload="none" data-hub-bundle="diff" src="http://assets.test/diff.js"></audio><audio preload="none" data-hub-bundle="markdown" src="http://assets.test/markdown.js"></audio><script type="module">${script}</script>`);
  await page.getByText('No commits in this range.').waitFor({ timeout: 5000 });
  assert.equal(diffRequests, 0); assert.equal(markdownRequests, 0);
  await page.getByRole('button', { name: 'Changes', exact: true }).click({ noWaitAfter: true });
  await assertEventually(() => assert.equal(diffRequests, 1));
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByText('Could not load markdown renderer').waitFor({ timeout: 5000 });
  await page.evaluate(() => globalThis.finishDiff());
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Tasks Markdown' }).waitFor({ timeout: 5000 });
  assert.equal(markdownRequests, 2);
  assert.equal(await page.locator('#view h1').textContent(), 'Tasks');
  assert.equal(await page.locator('.hub-diff').count(), 0);
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await page.locator('.hub-diff').waitFor({ state: 'attached', timeout: 5000 });
  assert.equal(diffRequests, 1);
});

test('timed-out and invalid renderer loads are removed and can be retried', { timeout: 30000 }, async t => {
  let selected = 'tasks', statusCalls = 0;
  const transport = await createHubTransport({
    status: () => { statusCalls++; return { available: true, selected }; }, documents: () => ({ documents: [] }),
    snapshot: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [] }),
    navigate: ({ id }) => { selected = id; return { selected }; },
    readDocument: () => ({ text: 'Tasks', hash: 'one', version: 'one' }),
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const page = await browser.newPage();
  await page.setContent(`<div id="app"></div><script>const originalTimeout = window.setTimeout; window.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 10000 ? 100 : ms, ...args); const append = document.head.append.bind(document.head); let attempts = 0; document.head.append = node => { if (node.src?.startsWith('http://assets.test/')) { node.type = 'application/x-test'; append(node); if (++attempts === 1) globalThis.staleLoad = node.onload; else if (attempts === 2) queueMicrotask(() => node.onload()); else { globalThis.hubMarkdownRenderer = () => () => {}; queueMicrotask(() => node.onload()); } } else append(node); }; globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><audio preload="none" data-hub-bundle="markdown" src="http://assets.test/markdown.js"></audio><script type="module">${script}</script>`);
  await page.getByText('Could not load markdown renderer').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('head script[src]').count(), 0);
  const before = statusCalls;
  await page.getByRole('button', { name: 'Refresh' }).click();
  await assertEventually(() => assert.ok(statusCalls > before));
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByText('Invalid markdown renderer').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('head script[src]').count(), 0);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Tasks Markdown' }).waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Commits', exact: true }).click();
  await page.evaluate(() => globalThis.staleLoad());
  assert.equal(await page.locator('#view h1').textContent(), 'Commits');
  assert.equal(await page.locator('#view textarea').count(), 0);
});

test('a stale document render cannot append another editor', { timeout: 30000 }, async t => {
  let selected = 'commits', reads = 0, releaseRead;
  const gate = new Promise(resolve => { releaseRead = resolve; });
  const transport = await createHubTransport({
    status: () => ({ available: true, selected }), documents: () => ({ documents: [] }),
    snapshot: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [] }),
    navigate: ({ id }) => { selected = id; return { selected }; },
    readDocument: async () => { const read = ++reads; if (read === 1) await gate; return { text: read === 1 ? 'Stale' : 'Current', hash: String(read), version: 'one' }; },
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { releaseRead(); await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const markdown = (await build({ entryPoints: ['web/hub-markdown.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser' })).outputFiles[0].text;
  const page = await browser.newPage();
  await page.setContent(`<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><script>${markdown.replaceAll('</script', '<\\/script')}</script><script type="module">${script}</script>`);
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await assertEventually(() => assert.equal(reads, 1));
  await page.getByRole('button', { name: 'Commits', exact: true }).click();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Tasks Markdown' }).click();
  const editor = page.getByRole('textbox', { name: 'Tasks Markdown' });
  await editor.fill('Draft');
  const response = page.waitForResponse(async response => response.url().endsWith('/action') && (await response.request().postDataJSON()).operation === 'readDocument');
  releaseRead();
  await response;
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  assert.equal(await page.locator('#view textarea').count(), 1);
  assert.equal(await editor.inputValue(), 'Draft');
  assert.equal(await page.locator('#view h1').count(), 1);
});

test('failed navigation survives polling and can be retried without losing a draft', { timeout: 30000 }, async t => {
  let selected = 'commits', attempts = 0, statusCalls = 0;
  const transport = await createHubTransport({
    status: () => { statusCalls++; return { available: true, selected }; }, documents: () => ({ documents: [] }),
    snapshot: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [] }),
    navigate: ({ id }) => { if (++attempts === 1) throw new Error('Navigation rejected'); selected = id; return { selected }; },
    readDocument: () => ({ text: 'Original', hash: 'one', version: 'one' }),
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const markdown = (await build({ entryPoints: ['web/hub-markdown.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser' })).outputFiles[0].text;
  const page = await browser.newPage();
  await page.setContent(`<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><script>${markdown.replaceAll('</script', '<\\/script')}</script><script type="module">${script}</script>`);
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByText('Navigation rejected').waitFor();
  await page.getByRole('button', { name: 'Edit Tasks Markdown' }).click();
  const editor = page.getByRole('textbox', { name: 'Tasks Markdown' });
  await editor.fill('Draft');
  const before = statusCalls;
  // A document view polls status and documents without a repository snapshot,
  // so wait for the poll a manual refresh runs here, and for its trailing status
  // write instead of a fixed delay.
  const statusWrite = page.evaluate(() => new Promise(resolve => {
    const node = document.querySelector('#connection');
    new MutationObserver((records, observer) => { observer.disconnect(); resolve(node.textContent); }).observe(node, { childList: true, characterData: true, subtree: true });
  }));
  const refreshed = page.waitForResponse(response => response.url().endsWith('/action') && response.request().postDataJSON().operation === 'documents');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await assertEventually(() => assert.ok(statusCalls > before));
  await refreshed;
  assert.equal(await statusWrite, 'Navigation rejected');
  assert.equal(await editor.inputValue(), 'Draft');
  assert.equal(await page.getByRole('button', { name: 'Tasks', exact: true }).getAttribute('aria-current'), 'page');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await assertEventually(() => assert.equal(selected, 'tasks'));
  await assertEventually(async () => assert.equal(await page.locator('#connection').textContent(), 'Connected'));
  assert.equal(await editor.inputValue(), 'Draft');
});

test('refresh updates clean documents and retains dirty drafts and their target', { timeout: 30000 }, async t => {
  let selected = 'tasks';
  let document = { text: 'First\n', hash: 'first', version: 'one' };
  let saved;
  const transport = await createHubTransport({
    status: () => ({ available: true, selected }), documents: () => ({ documents: [] }),
    navigate: ({ id }) => { selected = id; return { selected }; },
    snapshot: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [] }),
    readDocument: () => ({ ...document }),
    saveDocument: body => { saved = body; throw new Error('Document target changed'); },
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const page = await browser.newPage();
  const markdown = (await build({ entryPoints: ['web/hub-markdown.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser' })).outputFiles[0].text;
  await page.setContent(`<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><script>${markdown.replaceAll('</script', '<\\/script')}</script><script type="module">${script}</script>`);
  await page.getByRole('button', { name: 'Edit Tasks Markdown' }).click();
  const editor = page.getByRole('textbox', { name: 'Tasks Markdown' });
  await editor.waitFor();
  document = { text: 'External\n', hash: 'second', version: 'two' };
  await page.getByRole('button', { name: 'Refresh' }).click();
  await assertEventually(async () => assert.equal(await editor.inputValue(), 'External\n'));
  await editor.fill('Local draft\n');
  document = { text: 'Replacement\n', hash: 'third', version: 'three' };
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByText('Connected', { exact: true }).waitFor();
  assert.equal(await editor.inputValue(), 'Local draft\n');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Document target changed').waitFor();
  assert.equal(saved.version, 'two');
  assert.equal(saved.baseHash, 'second');
  assert.equal(await editor.inputValue(), 'Local draft\n');
});

test('unchanged snapshots preserve the focused editor and external changes render', { timeout: 30000 }, async t => {
  let calls = 0, description = 'Original\n';
  const transport = await createHubTransport({
    status: () => ({ available: true, selected: 'commits' }), documents: () => ({ documents: [] }),
    snapshot: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [{ changeId: 'c'.repeat(32), commitId: 'b'.repeat(40), description }], generated: String(++calls), operationId: String(calls) }),
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const page = await browser.newPage();
  await page.setContent(`<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><script type="module">${script}</script>`);
  await page.getByRole('button', { name: 'Edit Description cccccccccccc' }).click();
  const editor = page.getByRole('textbox', { name: 'Description cccccccccccc' });
  await editor.waitFor();
  await editor.focus();
  await page.evaluate(() => { globalThis.originalEditor = document.activeElement; });
  await assertEventually(() => assert.ok(calls >= 2));
  assert.equal(await page.evaluate(() => document.activeElement === globalThis.originalEditor && globalThis.originalEditor.isConnected), true);
  description = 'External\n';
  await assertEventually(async () => assert.equal(await editor.inputValue(), 'External\n'));
  assert.equal(await page.evaluate(() => globalThis.originalEditor.isConnected), false);
});

for (const activation of ['click', 'keyboard']) test(`activating an upper commit editor by ${activation} focuses its draft`, { timeout: 30000 }, async t => {
  let head = 'b'.repeat(40);
  const transport = await createHubTransport({
    status: () => ({ available: true, selected: 'commits' }), documents: () => ({ documents: [] }),
    snapshot: () => ({ base: 'a'.repeat(40), head, commits: [
      { changeId: 'c'.repeat(32), commitId: head, description: 'Upper' },
      { changeId: 'd'.repeat(32), commitId: 'e'.repeat(40), description: 'Lower' },
    ] }),
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const page = await browser.newPage();
  await page.setContent(`<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><script type="module">${script}</script>`);
  await page.getByRole('button', { name: 'Edit Description dddddddddddd' }).click();
  const lower = page.getByRole('textbox', { name: 'Description dddddddddddd' });
  await lower.fill('Lower draft');
  const display = page.getByRole('button', { name: 'Edit Description cccccccccccc' });
  if (activation === 'click') await display.click();
  else { await display.focus(); await page.keyboard.press('Enter'); }
  const upper = page.getByRole('textbox', { name: 'Description cccccccccccc' });
  assert.equal(await upper.evaluate(node => document.activeElement === node), true);
  await page.keyboard.type('!');
  assert.equal(await upper.inputValue(), 'Upper!');
  assert.equal(await lower.inputValue(), 'Lower draft');
  await upper.evaluate(node => node.setSelectionRange(2, 2));
  head = 'f'.repeat(40);
  await assertEventually(async () => assert.ok((await page.locator('.card h2').first().textContent()).includes('ffffffffffff')));
  assert.equal(await upper.evaluate(node => document.activeElement === node && node.selectionStart === 2 && node.selectionEnd === 2), true);
  assert.equal(await upper.inputValue(), 'Upper!');
  assert.equal(await lower.inputValue(), 'Lower draft');
});

test('commit descriptions render safely and retain draft targets across rewrites and errors', { timeout: 30000 }, async t => {
  let commitId = 'b'.repeat(40), description = '', saved;
  const changeId = 'c'.repeat(32);
  const transport = await createHubTransport({
    status: () => ({ available: true, selected: 'commits' }), documents: () => ({ documents: [] }),
    snapshot: () => ({ base: 'a'.repeat(40), head: commitId, stat: 'aggregate-only', commits: [{ changeId, commitId, description, stat: 'file | 2 +-\n1 file changed' }] }),
    describe: body => { saved = body; return { status: 'conflict', reason: 'stale', current: [{ description: 'External' }] }; },
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const css = await readFile(new URL('../web/hub.css', import.meta.url), 'utf8');
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.setContent(`<style>${themeCss}${css}</style><div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><script type="module">${script}</script>`);
  const display = page.locator('.commit-description');
  const edit = page.getByRole('button', { name: 'Edit Description cccccccccccc' });
  await edit.waitFor();
  assert.equal(await display.textContent(), '(no description set)');
  await display.click();
  assert.equal(await page.getByRole('textbox', { name: 'Description cccccccccccc' }).count(), 0);
  assert.equal(await display.evaluate(node => getComputedStyle(node).userSelect), 'auto');
  assert.equal(await page.getByText('--from aaaaaaaaaaaa --to bbbbbbbbbbbb', { exact: true }).count(), 1);
  assert.equal(await page.getByRole('region', { name: 'Feedback' }).count(), 0);
  assert.equal(await page.getByText('aggregate-only').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Changes', exact: true }).count(), 1);
  assert.equal(await page.locator('.stat-add').textContent(), '+');
  assert.equal(await page.locator('.stat-remove').textContent(), '-');
  assert.equal(await page.locator('.commit-stat').evaluate(node => getComputedStyle(node).resize), 'none');
  assert.equal(await display.evaluate(node => getComputedStyle(node).resize), 'none');
  await edit.focus(); await page.keyboard.press('Enter');
  const editor = page.getByRole('textbox', { name: 'Description cccccccccccc' });
  assert.ok(await editor.evaluate(node => node.getBoundingClientRect().height < 50));
  assert.equal(await editor.evaluate(node => getComputedStyle(node).resize), 'vertical');
  const saveStyle = await page.locator('.commit-save').evaluate(node => getComputedStyle(node).backgroundColor);
  const cancelStyle = await page.locator('.commit-cancel').evaluate(node => getComputedStyle(node).backgroundColor);
  assert.equal(saveStyle, 'rgb(184, 196, 122)'); assert.equal(cancelStyle, 'rgb(49, 43, 40)');
  assert.ok(await page.locator('.commit-controls').evaluate(node => parseFloat(getComputedStyle(node).gap) > 0));
  await editor.fill('<b>draft</b>\nsecond');
  commitId = 'd'.repeat(40); description = 'External\n';
  await page.getByRole('button', { name: 'Refresh' }).click();
  await assertEventually(async () => assert.equal(await editor.inputValue(), '<b>draft</b>\nsecond'));
  await page.getByRole('button', { name: 'Save description' }).click();
  await page.getByRole('alert').filter({ hasText: 'Conflict: stale' }).waitFor({ timeout: 5000 });
  assert.equal(saved.commitId, 'b'.repeat(40)); assert.equal(saved.expectedDescription, '');
  assert.equal(await editor.inputValue(), '<b>draft</b>\nsecond');
  assert.match(await page.getByRole('button', { name: 'Save description' }).getAttribute('title'), /Conflict: stale/);
  assert.equal(await page.locator('.save-failed').count(), 1);
});

test('successful description save survives an old snapshot and renders literal text', { timeout: 30000 }, async t => {
  const oldId = 'b'.repeat(40), newId = 'd'.repeat(40), changeId = 'c'.repeat(32);
  let current = { changeId, commitId: oldId, description: '' };
  const transport = await createHubTransport({
    status: () => ({ available: true, selected: 'commits' }), documents: () => ({ documents: [] }),
    snapshot: () => ({ base: 'a'.repeat(40), head: current.commitId, commits: [current] }),
    describe: () => ({ status: 'saved', current: { changeId, commitId: newId, description: '<b>literal</b>\nsecond\n' } }),
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const page = await browser.newPage();
  await page.setContent(`<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><script type="module">${script}</script>`);
  await page.getByRole('button', { name: 'Edit Description cccccccccccc' }).click();
  await page.getByRole('textbox', { name: 'Description cccccccccccc' }).fill('<b>literal</b>\nsecond');
  await page.getByRole('button', { name: 'Save description' }).click();
  const display = page.locator('.commit-description');
  await assertEventually(async () => assert.equal(await display.textContent(), '<b>literal</b>\nsecond\n'));
  assert.equal(await display.locator('b').count(), 0);
  current = { changeId, commitId: newId, description: '<b>literal</b>\nsecond\n' };
  await page.getByRole('button', { name: 'Refresh' }).click();
  await assertEventually(async () => assert.equal(await display.textContent(), current.description));
});

test('consecutive saves retain the latest target across an intermediate snapshot', { timeout: 30000 }, async t => {
  const changeId = 'c'.repeat(32), ids = ['a', 'b', 'd', 'e'].map(c => c.repeat(40));
  let current = { changeId, commitId: ids[0], description: 'A' }, releaseSecond;
  const requests = [];
  const transport = await createHubTransport({
    status: () => ({ available: true, selected: 'commits' }), documents: () => ({ documents: [] }),
    snapshot: () => ({ base: ids[0], head: current.commitId, commits: [{ ...current }] }),
    describe: async body => {
      requests.push(body);
      if (requests.length === 2) await new Promise(resolve => { releaseSecond = resolve; });
      current = { changeId, commitId: ids[requests.length], description: body.description };
      return { status: 'saved', current: { ...current } };
    },
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { releaseSecond?.(); await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const page = await browser.newPage();
  await page.setContent(`<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><script type="module">${script}</script>`);
  const edit = page.getByRole('button', { name: 'Edit Description cccccccccccc' });
  const display = page.locator('.commit-description');
  const editor = page.getByRole('textbox', { name: 'Description cccccccccccc' });
  assert.equal(await page.getByRole('button', { name: 'Save description' }).count(), 0);
  await edit.click(); await editor.fill('discard'); await editor.press('Escape');
  assert.equal(await display.textContent(), 'A');
  await edit.click(); await editor.fill('discard again'); await page.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await display.textContent(), 'A');
  await edit.click(); await editor.fill('B'); await page.getByRole('button', { name: 'Save description' }).click();
  await assertEventually(async () => assert.equal(await display.textContent(), 'B'));
  await edit.click(); await editor.fill('C'); await page.getByRole('button', { name: 'Save description' }).click();
  await assertEventually(() => assert.equal(requests.length, 2));
  await page.getByRole('button', { name: 'Refresh' }).click();
  await assertEventually(async () => assert.ok((await page.locator('.card h2').textContent()).includes(ids[1].slice(0, 12))));
  await editor.press('Escape'); assert.equal(await editor.inputValue(), 'C');
  releaseSecond();
  await assertEventually(async () => assert.equal(await display.textContent(), 'C'));
  await edit.click(); await editor.fill('D'); await page.getByRole('button', { name: 'Save description' }).click();
  await assertEventually(() => assert.equal(requests.length, 3));
  assert.equal(requests[1].commitId, ids[1]); assert.equal(requests[2].commitId, ids[2]);
  await assertEventually(async () => assert.equal(await display.textContent(), 'D'));
  current = { changeId, commitId: 'f'.repeat(40), description: 'External' };
  await page.getByRole('button', { name: 'Refresh' }).click();
  await assertEventually(async () => assert.equal(await display.textContent(), 'External'));
});

test('long rendered descriptions and statistics have resize handles, immutable commits do not offer editing', { timeout: 30000 }, async t => {
  const transport = await createHubTransport({
    status: () => ({ available: true, selected: 'commits' }), documents: () => ({ documents: [] }),
    snapshot: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [
      { changeId: 'c'.repeat(32), commitId: 'b'.repeat(40), description: Array(12).fill('Long description').join('\n'), stat: Array(10).fill('file | 1 +').join('\n') },
      { changeId: 'd'.repeat(32), commitId: 'e'.repeat(40), description: 'Immutable', immutable: true },
      { changeId: 'f'.repeat(32), commitId: 'f'.repeat(40), description: 'Divergent', divergent: true },
    ] }),
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const css = await readFile(new URL('../web/hub.css', import.meta.url), 'utf8');
  const page = await browser.newPage();
  await page.setContent(`<style>${css}</style><div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><script type="module">${script}</script>`);
  await page.getByRole('button', { name: 'Edit Description cccccccccccc' }).waitFor();
  for (const selector of ['.commit-description', '.commit-stat']) {
    const node = page.locator(selector).first();
    assert.equal(await node.evaluate(element => getComputedStyle(element).resize), 'vertical');
    assert.equal(await node.evaluate(element => element.scrollHeight > element.clientHeight), true);
  }
  const description = page.locator('.commit-description').first();
  await description.focus();
  assert.equal(await description.evaluate(element => document.activeElement === element), true);
  await page.keyboard.press('End');
  await assertEventually(async () => assert.ok(await description.evaluate(element => element.scrollTop > 0)));
  assert.equal(await page.getByRole('button', { name: 'Edit Description dddddddddddd' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Edit Description ffffffffffff' }).count(), 0);
});

test('description lines scroll horizontally without wrapping or changing text', { timeout: 30000 }, async t => {
  const text = 'W'.repeat(300) + '\nSecond line';
  let saved;
  const transport = await createHubTransport({
    status: () => ({ available: true, selected: 'commits' }), documents: () => ({ documents: [] }),
    snapshot: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [{ changeId: 'c'.repeat(32), commitId: 'b'.repeat(40), description: text }] }),
    describe: body => { saved = body.description; return { status: 'saved', current: { commitId: 'b'.repeat(40), description: body.description } }; },
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const css = await readFile(new URL('../web/hub.css', import.meta.url), 'utf8');
  const page = await browser.newPage({ viewport: { width: 2200, height: 900 } });
  await page.setContent(`<style>${css}</style><div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><script type="module">${script}</script>`);
  const display = page.locator('.commit-description');
  await display.waitFor();
  const dimensions = await display.evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth, height: node.clientHeight, line: parseFloat(getComputedStyle(node).lineHeight), max: getComputedStyle(node.parentElement).maxWidth, font: getComputedStyle(node).fontFamily, bodyFont: getComputedStyle(document.body).fontFamily, editRight: node.parentElement.querySelector('button').getBoundingClientRect().right, right: node.getBoundingClientRect().right }));
  assert.ok(dimensions.scroll > dimensions.width && dimensions.height <= dimensions.line * 2 + 2, JSON.stringify(dimensions));
  assert.ok(dimensions.width > 1000 && Math.abs(dimensions.width - parseFloat(dimensions.max)) < 2, JSON.stringify(dimensions)); assert.equal(dimensions.font, dimensions.bodyFont);
  assert.ok(Math.abs(dimensions.editRight - dimensions.right) < 2);
  assert.equal(await display.textContent(), text);
  await page.getByRole('button', { name: 'Edit Description cccccccccccc' }).click();
  const editor = page.getByRole('textbox', { name: 'Description cccccccccccc' });
  assert.equal(await editor.inputValue(), text);
  assert.equal(await editor.getAttribute('wrap'), 'off');
  assert.ok(await editor.evaluate(node => node.scrollWidth > node.clientWidth));
  await page.getByRole('button', { name: 'Save description' }).click();
  await assertEventually(() => assert.equal(saved, text));
  await page.setViewportSize({ width: 500, height: 900 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
});

test('Markdown controls save task toggles and retain failed drafts', { timeout: 30000 }, async t => {
  let selected = 'tasks', data = { text: '- [ ] First\n- [ ] Second\n', hash: 'one', version: 'v1' }, fail = false, release;
  const requests = [];
  const transport = await createHubTransport({
    status: () => ({ available: true, selected }), documents: () => ({ documents: [{ id: 'notes', title: 'Notes', source: 'notes.md' }] }),
    navigate: ({ id }) => { selected = id; return { selected }; },
    snapshot: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [] }),
    readDocument: () => ({ ...data }),
    saveDocument: async body => { requests.push(body); if (fail) throw new Error('Conflict saving task'); await new Promise(resolve => { release = resolve; }); data = { ...data, text: body.text, hash: 'two' }; return { reply: 'Saved' }; },
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const css = await readFile(new URL('../web/hub.css', import.meta.url), 'utf8');
  const markdown = (await build({ entryPoints: ['web/hub-markdown.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser' })).outputFiles[0].text;
  const page = await browser.newPage();
  await page.setContent(`<style>${css}</style><div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><script>${markdown.replaceAll('</script', '<\\/script')}</script><script type="module">${script}</script>`);
  const boxes = page.locator('.hub-markdown input[type=checkbox]');
  await boxes.first().waitFor();
  assert.equal(await page.getByText('Ready', { exact: true }).count(), 0);
  await boxes.first().check();
  await page.getByText('Saving…', { exact: true }).waitFor(); await assertEventually(() => assert.equal(requests.length, 1));
  assert.equal(await boxes.nth(1).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
  release(); await assertEventually(async () => assert.equal(await boxes.nth(1).isEnabled(), true));
  assert.equal(await page.getByText('Saved', { exact: true }).count(), 0);
  assert.equal(requests[0].baseHash, 'one'); assert.match(requests[0].text, /\[x\] First/);
  fail = true; await boxes.nth(1).check();
  await page.getByText('Conflict saving task').waitFor();
  const editor = page.getByRole('textbox', { name: 'Tasks Markdown' });
  assert.match(await editor.inputValue(), /\[x\] Second/); assert.equal(requests[1].baseHash, 'two');
  await editor.press('Escape'); assert.equal(await boxes.nth(1).isChecked(), false);
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Document Markdown' }).waitFor();
  assert.equal(await page.getByText('Ready', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Edit Document Markdown' }).click();
  const notes = page.getByRole('textbox', { name: 'Document Markdown' }); await notes.fill('Draft'); await notes.press('Escape');
  assert.equal(await page.getByRole('button', { name: 'Edit Document Markdown' }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Preview', exact: true }).count(), 0);
});

async function assertEventually(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (true) {
    try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
  }
}

let markdownScript;
async function pollingPage(browser, transport, { hidden = false } = {}) {
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  markdownScript ??= (await build({ entryPoints: ['web/hub-markdown.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser' })).outputFiles[0].text;
  // Polling pauses in a hidden tab, so drive visibility rather than waiting it out.
  const visibility = `<script>globalThis.__hidden = ${hidden}; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => globalThis.__hidden ? 'hidden' : 'visible' });</script>`;
  const page = await browser.newPage();
  await page.setContent(`${visibility}<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><script>${markdownScript.replaceAll('</script', '<\\/script')}</script><script type="module">${script}</script>`);
  return page;
}
const setTabHidden = (page, hidden) => page.evaluate(value => { globalThis.__hidden = value; document.dispatchEvent(new Event('visibilitychange')); }, hidden);
const commits = () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [] });
const launch = () => chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });

test('repository snapshots are requested only by repository views', { timeout: 30000 }, async t => {
  let selected = 'tasks', statusCalls = 0, snapshots = 0;
  const transport = await createHubTransport({
    status: () => { statusCalls++; return { available: true, selected }; },
    documents: () => ({ documents: [] }),
    navigate: ({ id }) => { selected = id; return { selected }; },
    snapshot: () => { snapshots++; return commits(); },
    readDocument: () => ({ text: '- [ ] Task\n', hash: 'one', version: 'one' }),
  });
  const browser = await launch();
  t.after(async () => { await browser.close(); await transport.close(); });
  const page = await pollingPage(browser, transport);
  await page.getByRole('heading', { name: 'Tasks' }).waitFor();
  await assertEventually(() => assert.ok(statusCalls >= 2));
  // The initial document selection never asks for the working-copy snapshot.
  assert.equal(snapshots, 0);
  await page.getByRole('button', { name: 'Commits', exact: true }).click();
  await page.getByText('No commits in this range.').waitFor({ timeout: 2000 });
  assert.ok(snapshots >= 1);
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('heading', { name: 'Tasks' }).waitFor();
  const during = snapshots, polls = statusCalls;
  await page.waitForTimeout(2300);
  // Polling continues on the document view, but without a snapshot request.
  assert.equal(snapshots, during);
  assert.ok(statusCalls > polls);
});

test('entering a repository view retries a failed snapshot', { timeout: 30000 }, async t => {
  let selected = 'commits', failing = true, snapshots = 0;
  const transport = await createHubTransport({
    status: () => ({ available: true, selected }), documents: () => ({ documents: [] }),
    navigate: ({ id }) => { selected = id; return { selected }; },
    snapshot: () => { snapshots++; if (failing) throw new Error('Snapshot failed'); return commits(); },
    readDocument: () => ({ text: '- [ ] Task\n', hash: 'one', version: 'one' }),
  });
  const browser = await launch();
  t.after(async () => { await browser.close(); await transport.close(); });
  const page = await pollingPage(browser, transport);
  await page.getByText('Repository snapshot unavailable. Refresh after checking the workspace and jj configuration.').waitFor();
  failing = false;
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('heading', { name: 'Tasks' }).waitFor();
  const before = snapshots;
  await page.getByRole('button', { name: 'Commits', exact: true }).click();
  await page.getByText('No commits in this range.').waitFor({ timeout: 2000 });
  assert.ok(snapshots > before);
});

test('a hidden tab stops polling and catches up when visible', { timeout: 30000 }, async t => {
  let statusCalls = 0;
  const transport = await createHubTransport({
    status: () => { statusCalls++; return { available: true, selected: 'commits' }; },
    documents: () => ({ documents: [] }), snapshot: () => commits(),
  });
  const browser = await launch();
  t.after(async () => { await browser.close(); await transport.close(); });
  const page = await pollingPage(browser, transport);
  await page.getByText('No commits in this range.').waitFor();
  await assertEventually(() => assert.ok(statusCalls >= 2));
  await setTabHidden(page, true);
  const hidden = statusCalls;
  await page.waitForTimeout(2300);
  assert.equal(statusCalls, hidden);
  await setTabHidden(page, false);
  // Catch-up runs at once rather than on the next two-second tick.
  await assertEventually(() => assert.ok(statusCalls > hidden), 1200);
});

test('entering a repository view requests a snapshot while a refresh is busy', { timeout: 30000 }, async t => {
  let releaseSnapshot, selected = 'commits', snapshots = 0;
  const gate = new Promise(resolve => { releaseSnapshot = resolve; });
  const transport = await createHubTransport({
    status: () => ({ available: true, selected }), documents: () => ({ documents: [] }),
    navigate: ({ id }) => { selected = id; return { selected }; },
    snapshot: async () => { snapshots++; if (snapshots === 1) await gate; return commits(); },
    readDocument: () => ({ text: '- [ ] Task\n', hash: 'one', version: 'one' }),
  });
  const browser = await launch();
  t.after(async () => { releaseSnapshot(); await browser.close(); await transport.close(); });
  const page = await pollingPage(browser, transport);
  await page.getByText('Loading repository snapshot…').waitFor({ timeout: 3000 });
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('heading', { name: 'Tasks' }).waitFor();
  await page.getByRole('button', { name: 'Commits', exact: true }).click();
  await page.getByRole('heading', { name: 'Commits' }).waitFor();
  await page.getByText('Loading repository snapshot…').waitFor();
  assert.equal(snapshots, 1);
  releaseSnapshot();
  await page.getByText('No commits in this range.').waitFor({ timeout: 3000 });
  // The busy-entry request is retried straight after the in-flight refresh.
  await assertEventually(() => assert.ok(snapshots >= 2), 1500);
});

test('a remote switch to a repository view asks for its snapshot in that poll', { timeout: 30000 }, async t => {
  let statusCalls = 0, snapshots = 0;
  const transport = await createHubTransport({
    status: () => { statusCalls++; return { available: true, selected: statusCalls >= 3 ? 'commits' : 'tasks' }; },
    documents: () => ({ documents: [] }),
    snapshot: () => { snapshots++; return commits(); },
    readDocument: () => ({ text: '- [ ] Task\n', hash: 'one', version: 'one' }),
  });
  const browser = await launch();
  t.after(async () => { await browser.close(); await transport.close(); });
  const page = await pollingPage(browser, transport);
  await page.getByRole('heading', { name: 'Tasks' }).waitFor();
  assert.equal(snapshots, 0);
  await page.getByText('No commits in this range.').waitFor({ timeout: 6000 });
  assert.ok(snapshots >= 1);
});

test('description drafts and save targets survive a gated view switch', { timeout: 30000 }, async t => {
  const changeId = 'c'.repeat(32), commitId = 'b'.repeat(40);
  let selected = 'commits', description = 'Original\n', saved;
  const transport = await createHubTransport({
    status: () => ({ available: true, selected }), documents: () => ({ documents: [] }),
    navigate: ({ id }) => { selected = id; return { selected }; },
    snapshot: () => ({ base: 'a'.repeat(40), head: commitId, commits: [{ changeId, commitId, description }] }),
    describe: body => { saved = body; description = body.description; return { status: 'saved', current: [{ changeId, commitId, description }] }; },
    readDocument: () => ({ text: '- [ ] Task\n', hash: 'one', version: 'one' }),
  });
  const browser = await launch();
  t.after(async () => { await browser.close(); await transport.close(); });
  const page = await pollingPage(browser, transport);
  await page.getByRole('button', { name: 'Edit Description cccccccccccc' }).click();
  await page.getByRole('textbox', { name: 'Description cccccccccccc' }).fill('Saved text\n');
  await page.getByRole('button', { name: 'Save description' }).click();
  await assertEventually(async () => assert.equal(await page.locator('.commit-description').textContent(), 'Saved text\n'));
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('heading', { name: 'Tasks' }).waitFor();
  await page.getByRole('button', { name: 'Commits', exact: true }).click();
  await page.getByRole('heading', { name: 'Commits' }).waitFor();
  await assertEventually(async () => assert.equal(await page.locator('.commit-description').textContent(), 'Saved text\n'));
  await page.getByRole('button', { name: 'Edit Description cccccccccccc' }).click();
  await page.getByRole('textbox', { name: 'Description cccccccccccc' }).fill('Second\n');
  await page.getByRole('button', { name: 'Save description' }).click();
  await assertEventually(() => assert.deepEqual([saved.description, saved.expectedDescription, saved.commitId], ['Second\n', 'Saved text\n', commitId]));
});

test('a snapshot failure on entry replaces the loading notice and recovers', { timeout: 30000 }, async t => {
  let selected = 'tasks', failing = true, snapshots = 0;
  const transport = await createHubTransport({
    status: () => ({ available: true, selected }), documents: () => ({ documents: [] }),
    navigate: ({ id }) => { selected = id; return { selected }; },
    snapshot: () => { snapshots++; if (failing) throw new Error('Snapshot failed'); return commits(); },
    readDocument: () => ({ text: '- [ ] Task\n', hash: 'one', version: 'one' }),
  });
  const browser = await launch();
  t.after(async () => { await browser.close(); await transport.close(); });
  const page = await pollingPage(browser, transport);
  await page.getByRole('heading', { name: 'Tasks' }).waitFor();
  const unavailable = page.getByText('Repository snapshot unavailable. Refresh after checking the workspace and jj configuration.');
  // No earlier snapshot rendered, so a failed first request has to replace the
  // loading notice rather than leave it on screen.
  await page.getByRole('button', { name: 'Commits', exact: true }).click();
  await page.getByText('Loading repository snapshot…').waitFor({ timeout: 2000 });
  await unavailable.waitFor({ timeout: 2000 });
  // Repeating the failure settles the same way instead of spinning again.
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('heading', { name: 'Tasks' }).waitFor();
  await page.getByRole('button', { name: 'Commits', exact: true }).click();
  await unavailable.waitFor({ timeout: 2000 });
  assert.equal(await page.getByText('Loading repository snapshot…').count(), 0);
  failing = false;
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('heading', { name: 'Tasks' }).waitFor();
  await page.getByRole('button', { name: 'Commits', exact: true }).click();
  await page.getByText('No commits in this range.').waitFor({ timeout: 3000 });
  assert.ok(snapshots >= 3);
});

test('a queued visibility catch-up polls without forcing a snapshot', { timeout: 30000 }, async t => {
  const forces = [];
  let releaseSnapshot;
  const gate = new Promise(resolve => { releaseSnapshot = resolve; });
  const transport = await createHubTransport({
    status: () => ({ available: true, selected: 'commits' }), documents: () => ({ documents: [] }),
    snapshot: async body => { forces.push(body.force); if (forces.length === 1) await gate; return commits(); },
  });
  const browser = await launch();
  t.after(async () => { releaseSnapshot(); await browser.close(); await transport.close(); });
  const page = await pollingPage(browser, transport);
  await page.getByText('Loading repository snapshot…').waitFor({ timeout: 3000 });
  await setTabHidden(page, true);
  await setTabHidden(page, false);
  releaseSnapshot();
  await page.getByText('No commits in this range.').waitFor({ timeout: 3000 });
  await assertEventually(() => assert.equal(forces.length, 2));
  // Catching up after a hidden tab is a plain poll: no uncached snapshot.
  assert.deepEqual(forces, [false, false]);
});

test('a manual refresh requested while busy or hidden stays forced', { timeout: 30000 }, async t => {
  const forces = [];
  let releaseSnapshot;
  const gate = new Promise(resolve => { releaseSnapshot = resolve; });
  const transport = await createHubTransport({
    status: () => ({ available: true, selected: 'commits' }), documents: () => ({ documents: [] }),
    snapshot: async body => { forces.push(body.force); if (forces.length === 1) await gate; return commits(); },
  });
  const browser = await launch();
  t.after(async () => { releaseSnapshot(); await browser.close(); await transport.close(); });
  const page = await pollingPage(browser, transport);
  await page.getByText('Loading repository snapshot…').waitFor({ timeout: 3000 });
  await page.getByRole('button', { name: 'Refresh' }).click();
  releaseSnapshot();
  await page.getByText('No commits in this range.').waitFor({ timeout: 3000 });
  await assertEventually(() => assert.equal(forces.length, 2));
  // The forced request queued behind the running refresh keeps its force.
  assert.deepEqual(forces, [false, true]);
  await setTabHidden(page, true);
  await page.getByRole('button', { name: 'Refresh' }).click();
  const queued = forces.length;
  await setTabHidden(page, false);
  await assertEventually(() => assert.equal(forces.length, queued + 1));
  assert.equal(forces.at(-1), true);
});

test('a repository view entered in a hidden tab asks for its snapshot when shown', { timeout: 30000 }, async t => {
  let selected = 'tasks', snapshots = 0;
  const transport = await createHubTransport({
    status: () => ({ available: true, selected }), documents: () => ({ documents: [] }),
    navigate: ({ id }) => { selected = id; return { selected }; },
    snapshot: () => { snapshots++; return commits(); },
    readDocument: () => ({ text: '- [ ] Task\n', hash: 'one', version: 'one' }),
  });
  const browser = await launch();
  t.after(async () => { await browser.close(); await transport.close(); });
  const page = await pollingPage(browser, transport);
  await page.getByRole('heading', { name: 'Tasks' }).waitFor();
  await setTabHidden(page, true);
  await page.getByRole('button', { name: 'Commits', exact: true }).click();
  await page.getByText('Loading repository snapshot…').waitFor({ timeout: 2000 });
  // A hidden tab runs no jj work, but the entry is still owed its snapshot.
  assert.equal(snapshots, 0);
  await setTabHidden(page, false);
  await page.getByText('No commits in this range.').waitFor({ timeout: 1500 });
  assert.equal(snapshots, 1);
});

test('a repository view entered over a stale snapshot marks it refreshing', { timeout: 30000 }, async t => {
  let selected = 'commits', head = 'b'.repeat(40), hold = false;
  const waiting = [];
  const release = () => { for (const resolve of waiting.splice(0)) resolve(); };
  const transport = await createHubTransport({
    status: () => ({ available: true, selected }), documents: () => ({ documents: [] }),
    navigate: ({ id }) => { selected = id; return { selected }; },
    snapshot: async () => { if (hold) await new Promise(resolve => waiting.push(resolve)); return { base: 'a'.repeat(40), head, commits: [] }; },
    readDocument: () => ({ text: '- [ ] Task\n', hash: 'one', version: 'one' }),
  });
  const browser = await launch();
  t.after(async () => { release(); await browser.close(); await transport.close(); });
  const page = await pollingPage(browser, transport);
  await page.getByText('--to bbbbbbbbbbbb').waitFor({ timeout: 3000 });
  const enterRepositoryView = async () => {
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.getByRole('heading', { name: 'Tasks' }).waitFor();
    await page.getByRole('button', { name: 'Commits', exact: true }).click();
    await assertEventually(() => assert.equal(waiting.length, 1));
  };
  hold = true;
  head = 'c'.repeat(40);
  await enterRepositoryView();
  // The previous snapshot stays on screen, labelled as the one being replaced.
  await page.getByText('Refreshing repository snapshot…').waitFor({ timeout: 2000 });
  assert.equal(await page.getByText('--to bbbbbbbbbbbb').count(), 1);
  hold = false;
  release();
  await page.getByText('--to cccccccccccc').waitFor({ timeout: 3000 });
  assert.equal(await page.getByText('Refreshing repository snapshot…').count(), 0);
  hold = true;
  await enterRepositoryView();
  await page.getByText('Refreshing repository snapshot…').waitFor({ timeout: 2000 });
  hold = false;
  release();
  // An unchanged snapshot still clears the marker.
  await assertEventually(async () => assert.equal(await page.getByText('Refreshing repository snapshot…').count(), 0));
  assert.equal(await page.getByText('--to cccccccccccc').count(), 1);
});

test('a page opened in a hidden tab warms once and waits for visibility', { timeout: 30000 }, async t => {
  let statusCalls = 0, snapshots = 0;
  const transport = await createHubTransport({
    status: () => { statusCalls++; return { available: true, selected: 'commits' }; },
    documents: () => ({ documents: [] }), snapshot: () => { snapshots++; return commits(); },
  });
  const browser = await launch();
  t.after(async () => { await browser.close(); await transport.close(); });
  const page = await pollingPage(browser, transport, { hidden: true });
  // The first refresh runs even in a background tab, so the page has content when
  // it is shown, and later polls wait for visibility.
  await page.getByText('No commits in this range.').waitFor({ timeout: 3000 });
  assert.equal(statusCalls, 1);
  await page.waitForTimeout(2300);
  assert.equal(statusCalls, 1);
  assert.equal(snapshots, 1);
  await setTabHidden(page, false);
  await assertEventually(() => assert.ok(statusCalls >= 2), 1200);
});

test('a document view reports an unavailable workspace without a snapshot', { timeout: 30000 }, async t => {
  let statusCalls = 0, snapshots = 0;
  const transport = await createHubTransport({
    status: () => { statusCalls++; return { available: false, selected: 'tasks' }; },
    documents: () => ({ documents: [] }), snapshot: () => { snapshots++; return commits(); },
    readDocument: () => ({ text: '- [ ] Task\n', hash: 'one', version: 'one' }),
  });
  const browser = await launch();
  t.after(async () => { await browser.close(); await transport.close(); });
  const page = await pollingPage(browser, transport);
  await page.getByRole('heading', { name: 'Tasks' }).waitFor();
  await assertEventually(async () => assert.equal(await page.locator('#connection').textContent(), 'Workspace unavailable'));
  const before = statusCalls;
  await assertEventually(() => assert.ok(statusCalls > before), 4000);
  // Views that render no snapshot still report the workspace state.
  assert.equal(snapshots, 0);
  assert.equal(await page.locator('#connection').textContent(), 'Workspace unavailable');
});
