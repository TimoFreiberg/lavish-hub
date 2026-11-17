import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createHubTransport } from '../src/hub-transport.mjs';

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
  await page.setContent(`<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><script type="module">${script}</script>`);
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
  await page.setContent(`<style>${css}</style><div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}</script><script type="module">${script}</script>`);
  const display = page.getByRole('button', { name: 'Edit Description cccccccccccc' });
  await display.waitFor();
  assert.equal(await display.textContent(), '(no description set)');
  assert.equal(await page.getByRole('region', { name: 'Feedback' }).count(), 0);
  assert.equal(await page.getByText('aggregate-only').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Changes', exact: true }).count(), 1);
  assert.equal(await page.locator('.stat-add').textContent(), '+');
  assert.equal(await page.locator('.stat-remove').textContent(), '-');
  assert.equal(await page.locator('.commit-stat').evaluate(node => getComputedStyle(node).resize), 'vertical');
  await display.focus(); await page.keyboard.press('Enter');
  const editor = page.getByRole('textbox', { name: 'Description cccccccccccc' });
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
  const display = page.getByRole('button', { name: 'Edit Description cccccccccccc' });
  await assertEventually(async () => assert.equal(await display.textContent(), '<b>literal</b>\nsecond\n'));
  assert.equal(await display.locator('b').count(), 0);
  current = { changeId, commitId: newId, description: '<b>literal</b>\nsecond\n' };
  await page.getByRole('button', { name: 'Refresh' }).click();
  await assertEventually(async () => assert.equal(await display.textContent(), current.description));
});

async function assertEventually(check) {
  const deadline = Date.now() + 5000;
  while (true) {
    try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
  }
}
