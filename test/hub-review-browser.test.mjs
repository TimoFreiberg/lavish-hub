import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { createHubTransport } from '../src/hub-transport.mjs';

const lifecycle = await readFile('web/hub-lifecycle.js', 'utf8');
const app = await readFile('web/hub-app.mjs', 'utf8');
const css = await readFile('web/hub.css', 'utf8');
const diffCss = await readFile('web/diff.css', 'utf8');
const bundle = (await build({ entryPoints: ['web/diff-app.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser', define: { LAVISH_HUB_LANGUAGES: '[]' } })).outputFiles[0].text;
const patch = name => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -5 +5 @@\n-old\n+new\n`;
const fullRange = '--from fork_point(trunk() | @) --to @';

async function fixture(t, { opaque = false } = {}) {
  const commits = Array.from({ length: 24 }, (_, i) => ({ changeId: String.fromCharCode(97 + i).repeat(32), commitId: i.toString(16).padStart(40, '0'), description: i === 1 ? 'Subject without body' : `Subject ${i}\n\nBody ${i}`, isWorkingCopy: i === 0 }));
  const snapshot = { operationId: 'f'.repeat(128), version: 'v1', base: 'a'.repeat(40), head: 'b'.repeat(40), baseDisplay: 'fork_point(trunk() | @)', headDisplay: '@', commits, patch: patch('a.txt') + patch('b.txt') };
  const calls = [], saves = [];
  let conflict = false;
  const transport = await createHubTransport({
    status: () => ({ available: true, selected: 'diff' }), documents: () => ({ documents: [] }), snapshot: () => snapshot, navigate: () => ({}),
    diffRange: request => { calls.push(request); return { patch: patch('a.txt') + patch('c.txt'), version: 'range-version', rangeKey: JSON.stringify(request) }; },
    describe: request => { saves.push(request); return conflict ? { status: 'conflict', reason: 'stale', current: [{ description: 'External' }] } : { status: 'saved', current: { commitId: request.commitId, description: request.description } }; },
    diffFiles: () => ({ oldFile: { name: 'a.txt', contents: 'one\ntwo\nthree\nfour\nold\n' }, newFile: { name: 'a.txt', contents: 'one\ntwo\nthree\nfour\nnew\n' } }),
  });
  t.after(() => transport.close());
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.setDefaultTimeout(5000);
  const config = JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' });
  const mockFetch = opaque ? `globalThis.fetch=async (_,init) => { const operation=JSON.parse(init.body).operation; const result=operation==='status' ? {available:true,selected:'diff'} : operation==='documents' ? {documents:[]} : operation==='snapshot' ? ${JSON.stringify(snapshot)} : {}; return {ok:true,json:async()=>({result})}; };` : '';
  const html = `<style>${css} @scope (.hub-diff) { ${diffCss} }</style><div id="app"></div><script>globalThis.hubConfig=${config}; globalThis.lavishPreview=true; ${mockFetch}</script><script>${bundle.replaceAll('</script', '<\\/script')}</script><script>${lifecycle}</script><script type="module">${app}</script>`;
  if (opaque) {
    await page.route('http://hub.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.setContent('<iframe sandbox="allow-scripts" src="http://hub.test/hub.html" style="width:1200px;height:800px"></iframe>');
  } else await page.setContent(html);
  const view = opaque ? page.frameLocator('iframe') : page;
  await view.locator('.rail-row').first().waitFor();
  return { page, view, commits, snapshot, calls, saves, setConflict: value => { conflict = value; } };
}

test('full_viewport_diff_layout', { timeout: 30000 }, async t => {
  const { page } = await fixture(t);
  assert.equal(await page.locator('#app.is-diff-view').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Diff', exact: true }).getAttribute('aria-current'), 'page');
  for (const name of ['Commits', 'Changes']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => document.querySelector('#app').getBoundingClientRect().height === innerHeight && document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 480, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('.commit-rail-scroll').evaluate(node => getComputedStyle(node).overflowY), 'visible');
});

test('commit_rail_order_and_clean_rows', { timeout: 30000 }, async t => {
  const { page, commits } = await fixture(t);
  const rows = page.locator('.rail-row');
  assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => node.dataset.changeId)), commits.map(commit => commit.changeId));
  assert.match(await rows.first().locator('.rail-sub').textContent(), / · @$/);
  assert.doesNotMatch(await rows.nth(1).locator('.rail-sub').textContent(), /@/);
  assert.equal(await page.locator('.commit-stat,.stat-add,.stat-remove').count(), 0);
  assert.equal(await page.locator('.rail-row').count(), 24);
});

test('commit_body_peek_chevron_and_hover_title', { timeout: 30000 }, async t => {
  const { page, commits } = await fixture(t);
  const row = page.locator('.rail-row').first();
  assert.equal(await row.locator('.rail-subj').getAttribute('title'), commits[0].description);
  assert.equal(await page.locator('.rail-row').nth(1).locator('.body-peek-btn').isVisible(), false);
  await row.locator('.body-peek-btn').click();
  assert.equal(await row.locator('.rail-body-preview').textContent(), 'Body 0');
  assert.equal(await page.locator('.review-range-text').textContent(), fullRange);
  await row.locator('.body-peek-btn').click();
  assert.equal(await row.locator('.rail-body-preview').isVisible(), false);
});

test('sidebar_and_rail_collapse_resize_and_opaque_fallback', { timeout: 30000 }, async t => {
  const { page, view } = await fixture(t, { opaque: true });
  await view.locator('.hub-sidebar-toggle').click();
  assert.equal(await view.locator('#navigation').isVisible(), false);
  await view.locator('.hub-sidebar-toggle').click();
  await view.locator('.rail-toggle').click();
  assert.equal(await view.locator('.commit-rail-scroll').isVisible(), false);
  await view.locator('.rail-toggle').click();
  for (const [selector, pane] of [['.pane-resizer', '.hub-sidebar'], ['.rail-resizer', '.commit-rail']]) {
    const before = (await view.locator(pane).boundingBox()).width;
    const resizer = view.locator(selector);
    const box = await resizer.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 20); await page.mouse.down(); await page.mouse.move(box.x + 80, box.y + 20); await page.mouse.up();
    assert.ok((await view.locator(pane).boundingBox()).width > before);
  }
  const width = (await view.locator('.commit-rail').boundingBox()).width;
  await view.locator('.rail-toggle').click();
  await view.locator('.rail-toggle').click();
  assert.equal((await view.locator('.commit-rail').boundingBox()).width, width);
  assert.equal(await view.locator('.commit-rail-scroll').isVisible(), true);
});

test('commit_rail_preserves_scroll_and_dom_on_selection_and_edit', { timeout: 30000 }, async t => {
  const { page } = await fixture(t);
  const scroll = page.locator('.commit-rail-scroll');
  await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; globalThis.savedScroll = node; globalThis.savedRow = node.lastElementChild; globalThis.savedTop = node.scrollTop; });
  const last = page.locator('.rail-row').last();
  await last.locator('.rail-pick').click();
  await last.locator('.body-peek-btn').click();
  await last.locator('.commit-edit').click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.evaluate(() => savedScroll === document.querySelector('.commit-rail-scroll') && savedRow === savedScroll.lastElementChild && savedScroll.scrollTop === savedTop), true);
  const id = await last.getAttribute('data-change-id');
  await page.locator('.rail-toggle').click();
  await page.evaluate(changeId => { const link = document.createElement('a'); link.href = `?view=diff&change=${changeId}`; link.textContent = 'Open commit'; document.querySelector('.review-range-bar').append(link); }, id.slice(0, 12));
  await page.getByText('Open commit').click();
  await page.locator('.rail-row.deep-link-highlight').waitFor();
  assert.equal(await scroll.isVisible(), true);
  assert.equal(await page.locator('.review-range-text').textContent(), fullRange);
});

test('range_selection_click_shift_click_reset_and_cli_syntax', { timeout: 30000 }, async t => {
  const { page, commits, calls, snapshot } = await fixture(t);
  const rows = page.locator('.rail-row');
  assert.equal(await page.locator('.review-range-text').textContent(), fullRange);
  assert.equal(await page.locator('.review-range-text').evaluate(node => getComputedStyle(node).userSelect), 'text');
  await rows.nth(3).locator('.rail-pick').click();
  await page.waitForFunction(() => document.querySelector('.review-range-status').textContent === '');
  assert.equal(await page.locator('.review-range-text').textContent(), `-r ${commits[3].changeId.slice(0, 12)}`);
  assert.equal(calls.at(-1).rev, commits[3].commitId);
  await rows.nth(6).locator('.rail-pick').click({ modifiers: ['Shift'] });
  await page.waitForFunction(() => document.querySelector('.review-range-status').textContent === '');
  assert.equal(await page.locator('.review-range-text').textContent(), `--from ${commits[7].changeId.slice(0, 12)} --to ${commits[3].changeId.slice(0, 12)}`);
  assert.equal(calls.at(-1).from, commits[7].commitId);
  assert.equal(calls.at(-1).to, commits[3].commitId);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  assert.equal(await page.locator('.review-range-text').textContent(), fullRange);
  await rows.last().locator('.rail-pick').click();
  await rows.last().locator('.rail-pick').click();
  assert.equal(await page.locator('.review-range-text').textContent(), `--from ${snapshot.baseDisplay} --to ${snapshot.headDisplay}`);
});

test('codeview_collapsed_default_header_click_expand_all_and_preserve_expanded', { timeout: 30000 }, async t => {
  const { page } = await fixture(t);
  assert.equal(await page.locator('.hub-diff .file-tree').count(), 0);
  await page.getByRole('button', { name: 'Expand a.txt' }).waitFor();
  assert.equal((await page.locator('.file-header[data-file="a.txt"]').boundingBox()).height, 44);
  await page.locator('.file-header[data-file="a.txt"] .path').click();
  await page.getByRole('button', { name: 'Collapse a.txt' }).waitFor();
  await page.locator('.rail-row').first().locator('.rail-pick').click();
  await page.getByRole('button', { name: 'Expand c.txt' }).waitFor();
  await page.getByRole('button', { name: 'Collapse a.txt' }).waitFor();
  await page.getByRole('button', { name: 'Collapse all' }).click();
  await page.getByRole('button', { name: 'Expand a.txt' }).waitFor();
  await page.getByRole('button', { name: 'Expand all' }).click();
  await page.getByRole('button', { name: 'Collapse c.txt' }).waitFor();
});

test('commit_editor_drawer_auto_narrow_restore_manual_override_and_conflict', { timeout: 30000 }, async t => {
  const { page, commits, saves, setConflict } = await fixture(t);
  const rows = page.locator('.rail-row');
  await rows.nth(1).locator('.rail-pick').click();
  const prior = await page.locator('.review-range-text').textContent();
  await rows.nth(2).locator('.commit-edit').click();
  assert.equal(await page.locator('.review-range-text').textContent(), `-r ${commits[2].changeId.slice(0, 12)}`);
  const editor = page.getByRole('textbox', { name: `Description ${commits[2].changeId.slice(0, 12)}` });
  await editor.fill('draft'); await editor.press('Escape');
  assert.equal(await page.locator('.review-range-text').textContent(), prior);
  await rows.nth(2).locator('.commit-edit').click();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.locator('.review-range-text').textContent(), fullRange);
  await rows.nth(2).locator('.commit-edit').click();
  await editor.fill('conflicting draft'); setConflict(true);
  await page.getByRole('button', { name: 'Save description' }).click();
  await page.getByRole('alert').filter({ hasText: 'Conflict: stale' }).waitFor();
  assert.equal(await editor.inputValue(), 'conflicting draft');
  assert.equal(saves.at(-1).description, 'conflicting draft');
  setConflict(false); await page.getByRole('button', { name: 'Save description' }).click();
  await page.locator('.commit-editor-drawer').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.review-range-text').textContent(), fullRange);
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
