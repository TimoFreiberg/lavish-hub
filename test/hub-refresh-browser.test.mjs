import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createHubTransport } from '../src/hub-transport.mjs';
import { build } from 'esbuild';
import { themeCss } from '../src/orangebox.mjs';

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

async function assertEventually(check) {
  const deadline = Date.now() + 5000;
  while (true) {
    try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
  }
}
