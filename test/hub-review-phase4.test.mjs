import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createHubTransport } from '../src/hub-transport.mjs';

const lifecycle = await readFile(new URL('../web/hub-lifecycle.js', import.meta.url), 'utf8');
const app = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
const css = await readFile(new URL('../web/hub.css', import.meta.url), 'utf8');

test('diff rail preserves rows and restores the range after editing', { timeout: 30000 }, async t => {
  const commits = Array.from({ length: 24 }, (_, i) => ({ changeId: String.fromCharCode(97 + i).repeat(32), commitId: i.toString(16).padStart(40, '0'), description: `Subject ${i}\n\nBody ${i}`, isWorkingCopy: i === 0 }));
  const snapshot = { operationId: 'f'.repeat(128), version: 'v1', base: 'a'.repeat(40), head: 'b'.repeat(40), baseDisplay: 'fork_point(trunk() | @)', headDisplay: '@', commits, patch: 'full' };
  const calls = [];
  const transport = await createHubTransport({
    status: () => ({ available: true, selected: 'diff' }), documents: () => ({ documents: [] }),
    snapshot: () => snapshot, navigate: () => ({}),
    diffRange: request => { calls.push(request); return { patch: 'narrow', version: 'range-version', rangeKey: JSON.stringify(request) }; },
  });
  t.after(() => transport.close());
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.setContent(`<style>${css}</style><div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}; globalThis.mountLavishDiff = () => ({ hide() {}, hasUnsavedDraft() { return false; }, update(data) { globalThis.lastDiff = data; }, revealTarget(target) { globalThis.revealed = target; } });</script><script>${lifecycle}</script><script type="module">${app}</script>`);
  await page.locator('.rail-row').first().waitFor();
  assert.equal(await page.locator('.rail-row').count(), 24);
  assert.equal(await page.locator('.review-range-text').textContent(), '--from fork_point(trunk() | @) --to @');
  const scroll = page.locator('.commit-rail-scroll');
  await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; globalThis.savedScroll = node; globalThis.savedRow = node.lastElementChild; });
  const last = page.locator('.rail-row').last();
  await last.locator('.rail-pick').click();
  await page.waitForFunction(() => globalThis.lastDiff?.patch === 'narrow');
  assert.equal(await page.locator('.review-range-text').textContent(), `-r ${commits[23].changeId.slice(0, 12)}`);
  assert.equal(calls.at(-1).rev, commits[23].commitId);
  await last.locator('.body-peek-btn').click();
  assert.equal(await last.locator('.rail-body-preview').isVisible(), true);
  assert.equal(await page.evaluate(() => savedScroll === document.querySelector('.commit-rail-scroll') && savedRow === savedScroll.lastElementChild && savedScroll.scrollTop > 0), true);
  await page.locator('.rail-row').nth(20).locator('.rail-pick').click({ modifiers: ['Shift'] });
  assert.equal(await page.locator('.review-range-text').textContent(), `--from ${snapshot.baseDisplay} --to ${commits[20].changeId.slice(0, 12)}`);
  const prior = await page.locator('.review-range-text').textContent();
  await last.locator('.commit-edit').click();
  const area = page.getByRole('textbox', { name: `Description ${commits[23].changeId.slice(0, 12)}` });
  assert.equal(await area.evaluate(node => document.activeElement === node), true);
  await area.fill('A draft');
  await area.press('Escape');
  assert.equal(await page.locator('.commit-editor-drawer').isVisible(), false);
  assert.equal(await page.locator('.review-range-text').textContent(), prior);
  assert.equal(await page.evaluate(() => savedRow === savedScroll.lastElementChild && savedScroll.scrollTop > 0), true);
  await last.locator('.commit-edit').click();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.locator('.review-range-text').textContent(), '--from fork_point(trunk() | @) --to @');
  await page.locator('.rail-toggle').click();
  assert.equal(await scroll.isVisible(), false);
  await page.evaluate(id => { const link = document.createElement('a'); link.href = `?view=diff&change=${id}`; link.textContent = 'Open commit'; document.querySelector('.review-range-bar').append(link); }, commits[23].changeId.slice(0, 12));
  await page.getByText('Open commit').click();
  await page.waitForFunction(() => document.querySelector('.rail-row.deep-link-highlight'));
  assert.equal(await scroll.isVisible(), true);
  assert.equal(await page.locator('.review-range-text').textContent(), '--from fork_point(trunk() | @) --to @');
  await page.locator('.hub-sidebar-toggle').click();
  assert.equal(await page.locator('#navigation').isVisible(), false);
  await page.locator('.hub-sidebar-toggle').click();
  await page.setViewportSize({ width: 480, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('an invalid initial view falls back to diff', { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const results = { status: { available: true, selected: 'tasks' }, documents: { documents: [] }, snapshot: { base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [], patch: '' } };
  const html = `<div id="app"></div><script>globalThis.hubConfig={url:'http://unused.test',workspace:'test'}; const results=${JSON.stringify(results)}; globalThis.fetch=async (_,init) => ({ok:true,json:async () => ({result:results[JSON.parse(init.body).operation] || {}})}); globalThis.mountLavishDiff = () => ({ hide() {}, update() {}, hasUnsavedDraft() { return false; } });</script><script>${lifecycle}</script><script type="module">${app}</script>`;
  await page.route('http://hub.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.setContent('<iframe sandbox="allow-scripts" src="http://hub.test/hub.html?view=unknown"></iframe>');
  const frame = page.frameLocator('iframe');
  await frame.getByText('No commits in this range.').waitFor({ timeout: 5000 });
  assert.equal(await frame.locator('.deep-link-notice').textContent(), 'Unknown view "unknown".');
  assert.equal(await frame.getByRole('button', { name: 'Diff', exact: true }).getAttribute('aria-current'), 'page');
});
