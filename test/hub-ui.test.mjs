import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { createHubTransport } from '../src/hub-transport.mjs';
import { ensureHubAssets } from '../src/deps.mjs';
import path from 'node:path';
import { build } from 'esbuild';
const markdownBundle = async () => (await build({ entryPoints: ['web/hub-markdown.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser' })).outputFiles[0].text;
const penPath = 'M4 20l4-.8L19 8.2 15.8 5 4.8 16 4 20zm10.6-13.8l3.2 3.2';
async function assertEditButton(button, label) {
  await button.waitFor();
  assert.equal(await button.getAttribute('aria-label'), label);
  assert.equal(await button.getAttribute('title'), label);
  assert.equal(await button.textContent(), '');
  assert.equal(await button.locator('svg').getAttribute('aria-hidden'), 'true');
  assert.equal(await button.locator('svg path').getAttribute('d'), penPath);
  await button.focus();
  assert.equal(await button.evaluate(node => document.activeElement === node), true);
  await button.press('Enter');
}

test('published Markdown previews relative assets and retains conflicting edits', { timeout: 120000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-markdown-'));
  const source = path.join(dir, 'review.md');
  await writeFile(source, '# Review\n\n![diagram](image.svg)\n');
  await writeFile(path.join(dir, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="10"/>');
  const doc = { id: 'review', title: 'Review', source };
  const transport = await createHubTransport({
    status: () => ({ available: true, selected: 'review' }), documents: () => ({ documents: [doc] }),
    snapshot: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [] }),
    readDocument: async () => ({ text: await readFile(source, 'utf8'), hash: 'hash', version: 'version' }),
    saveDocument: () => ({ reply: 'Conflict: source changed' }),
  }, { resource: id => id === 'review' ? source : undefined });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); await rm(dir, { recursive: true, force: true }); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const markdown = await markdownBundle();
  const page = await browser.newPage();
  await page.setContent(`<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, resourceKey: transport.resourceKey, workspace: 'test' })}</script><script>${markdown.replaceAll('</script', '<\\/script')}</script><script type="module">${script}</script>`);
  const area = page.getByRole('textbox', { name: 'Document Markdown' });
  await page.getByRole('button', { name: 'Edit Document Markdown' }).waitFor();
  assert.equal(await area.isVisible(), false);
  await page.getByRole('heading', { name: 'Review', level: 1 }).last().waitFor();
  await page.locator('.hub-markdown img').evaluate(image => image.decode());
  assert.equal(await page.locator('.hub-markdown img').evaluate(image => image.naturalWidth), 12);
  await assertEditButton(page.getByRole('button', { name: 'Edit Document Markdown' }), 'Edit Document Markdown');
  assert.equal(await area.evaluate(node => document.activeElement === node), true);
  await area.fill('# Draft\n');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Conflict: source changed').waitFor();
  assert.equal(await area.inputValue(), '# Draft\n');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('heading', { name: 'Review', level: 1 }).last().waitFor();
});

test('hub bounds a hung diff file read, keeps the patch, and retries the expansion', { timeout: 40000 }, async t => {
  let reads = 0;
  const files = { oldFile: { name: 'hung.txt', contents: 'one\ntwo\nthree\nfour\nold\n' }, newFile: { name: 'hung.txt', contents: 'one\ntwo\nthree\nfour\nnew\n' } };
  const transport = await createHubTransport({
    status: () => ({ available: true }), documents: () => ({ documents: [] }), navigate: ({ id }) => ({ selected: id }),
    snapshot: () => ({ operationId: 'd'.repeat(128), base: 'c'.repeat(40), head: 'b'.repeat(40), stat: '1 file changed', patch: 'diff --git a/hung.txt b/hung.txt\n--- a/hung.txt\n+++ b/hung.txt\n@@ -5 +5 @@\n-old\n+new\n', commits: [] }),
    // The owner never answers the first read, so only the client-side bound can
    // end it. The second attempt answers, so a retry can still succeed.
    diffFiles: () => { reads += 1; return reads === 1 ? new Promise(() => {}) : files; },
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const dist = await ensureHubAssets();
  const bundle = (await build({ entryPoints: ['web/diff-app.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser', define: { LAVISH_KIT_LANGUAGES: '[]' } })).outputFiles[0].text;
  const markdown = await markdownBundle();
  const css = await readFile(path.join(dist, 'diff.css'), 'utf8');
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.setContent(`<html data-theme="light"><style>@scope (.hub-diff) { ${css} } .hub-diff { height: 600px; display: flex; flex-direction: column }</style><div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: '/workspace' })};</script><script>${bundle.replaceAll('</script', '<\\/script')}</script><script>${markdown.replaceAll('</script', '<\\/script')}</script><script type="module">${script}</script>`);
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await page.locator('.file-link[data-path="hung.txt"]').waitFor();
  await page.locator('[data-expand-button]').first().click();
  await page.getByText('Unchanged lines are unavailable for this file or snapshot. The original diff is still shown.').waitFor({ timeout: 20000 });
  assert.equal(reads, 1);
  // The abandoned expansion left the patch it could not complete untouched.
  const lineTypes = await page.locator('[data-gutter] [data-line-type]').evaluateAll(nodes => nodes.map(node => node.dataset.lineType));
  assert.deepEqual(lineTypes, ['change-deletion', 'change-addition']);
  await page.locator('[data-expand-button]:visible').first().click();
  await page.getByText('four', { exact: true }).first().waitFor();
  assert.equal(reads, 2);
  assert.equal(await page.getByText('Unchanged lines are unavailable for this file or snapshot. The original diff is still shown.').count(), 0);
});

test('hub keeps an unavailable file expansion notice until that file expands', { timeout: 40000 }, async t => {
  const reads = [];
  let bUnavailable = true;
  const fileFor = name => ({ oldFile: { name, contents: 'one\ntwo\nthree\nfour\nold\n' }, newFile: { name, contents: 'one\ntwo\nthree\nfour\nnew\n' } });
  const patch = ['a.txt', 'b.txt'].map(name => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -5 +5 @@\n-old\n+new\n`).join('');
  const transport = await createHubTransport({
    status: () => ({ available: true }), documents: () => ({ documents: [] }), navigate: ({ id }) => ({ selected: id }),
    snapshot: () => ({ operationId: 'd'.repeat(128), base: 'c'.repeat(40), head: 'b'.repeat(40), stat: '2 files changed', patch, commits: [] }),
    diffFiles: ({ fileIndex }) => { reads.push(fileIndex); if (fileIndex === 1 && bUnavailable) throw new Error('unavailable'); return fileFor(fileIndex === 0 ? 'a.txt' : 'b.txt'); },
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const dist = await ensureHubAssets();
  const bundle = (await build({ entryPoints: ['web/diff-app.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser', define: { LAVISH_KIT_LANGUAGES: '[]' } })).outputFiles[0].text;
  const markdown = await markdownBundle();
  const css = await readFile(path.join(dist, 'diff.css'), 'utf8');
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.setContent(`<html data-theme="light"><style>@scope (.hub-diff) { ${css} } .hub-diff { height: 600px; display: flex; flex-direction: column }</style><div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: '/workspace' })};</script><script>${bundle.replaceAll('</script', '<\\/script')}</script><script>${markdown.replaceAll('</script', '<\\/script')}</script><script type="module">${script}</script>`);
  const unavailable = page.getByText('Unchanged lines are unavailable for this file or snapshot. The original diff is still shown.');
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await page.locator('.file-link[data-path="a.txt"]').waitFor();
  await page.locator('.file-link[data-path="b.txt"]').click();
  await page.locator('[data-expand-button]:visible').last().click();
  await unavailable.waitFor();
  assert.deepEqual(reads, [1]);
  assert.equal(await page.getByText('four', { exact: true }).count(), 0);
  // a.txt expands, and that success says nothing about b.txt's unavailable read.
  await page.locator('.file-link[data-path="a.txt"]').click();
  await page.locator('[data-expand-button]').first().click();
  await page.getByText('four', { exact: true }).first().waitFor();
  assert.deepEqual(reads, [1, 0]);
  assert.equal(await unavailable.count(), 1);
  // Only b.txt's own retry clears the notice it raised.
  bUnavailable = false;
  await page.locator('.file-link[data-path="b.txt"]').click();
  await page.locator('[data-expand-button]:visible').last().click();
  await unavailable.waitFor({ state: 'detached' });
  assert.deepEqual(reads, [1, 0, 1]);
});

test('hub keeps description drafts across navigation and stale saves', { timeout: 30000 }, async t => {
  const commit = { changeId: 'a'.repeat(32), commitId: 'b'.repeat(40), description: 'Original\n', immutable: false, divergent: false };
  let taskText = '- [ ] Task\n\n> - [ ] Quoted\n';
  const transport = await createHubTransport({
    status: () => ({ available: true }), documents: () => ({ documents: [] }), navigate: ({ id }) => ({ selected: id }),
    snapshot: () => ({ operationId: 'd'.repeat(128), base: 'c'.repeat(40), head: 'b'.repeat(40), stat: '1 file changed', patch: 'diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -5 +5 @@\n-old\n+new\ndiff --git a/unavailable.txt b/unavailable.txt\n--- a/unavailable.txt\n+++ b/unavailable.txt\n@@ -5 +5 @@\n-old\n+new\n', commits: [commit] }),
    diffFiles: body => { assert.equal(body.operationId, 'd'.repeat(128)); if (body.fileIndex === 1) throw new Error('unavailable'); assert.equal(body.fileIndex, 0); return { oldFile: { name: 'example.txt', contents: 'one\ntwo\nthree\nfour\nold\n' }, newFile: { name: 'example.txt', contents: 'one\ntwo\nthree\nfour\nnew\n' } }; },
    describe: () => ({ status: 'conflict', reason: 'stale', current: [{ description: 'External\n' }] }),
    readDocument: () => ({ text: taskText, hash: taskText, version: 'version' }),
    saveDocument: ({ text }) => { taskText = text; return { reply: 'Saved' }; },
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const dist = await ensureHubAssets();
  const bundle = (await build({ entryPoints: ['web/diff-app.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser', define: { LAVISH_KIT_LANGUAGES: '[]' } })).outputFiles[0].text;
  const markdown = await markdownBundle();
  const css = await readFile(path.join(dist, 'diff.css'), 'utf8');
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.setContent(`<html data-theme="light"><style>@scope (.hub-diff) { ${css} } .hub-diff { height: 600px; display: flex; flex-direction: column }</style><div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: '/workspace' })}; globalThis.queued=[]; globalThis.lavish={queuePromptAcknowledged:async (...args)=>{queued.push(args);return {status:'accepted'}},releaseQueueRequest:()=>{},sendQueuedPrompts:()=>{throw new Error('send failed')}};</script><script>${bundle.replaceAll('</script', '<\\/script')}</script><script>${markdown.replaceAll('</script', '<\\/script')}</script><script type="module">${script}</script>`);
  await assertEditButton(page.getByRole('button', { name: 'Edit Description aaaaaaaaaaaa' }), 'Edit Description aaaaaaaaaaaa');
  const description = page.getByRole('textbox', { name: /Description/ });
  await description.waitFor();
  assert.equal(await description.evaluate(node => document.activeElement === node), true);
  await description.fill('My draft');
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await page.locator('.file-link[data-path="example.txt"]').waitFor();
  const zed = page.locator('.file-header a').first();
  assert.equal(await zed.textContent(), 'Open in Zed');
  assert.match(await zed.getAttribute('href'), /example\.txt:5/);
  assert.equal(await page.getByText('Working tree may differ from the reviewed revision').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Copy Zed command :5' }).count(), 2);
  for (const selector of ['.file-header .path', '.file-header .viewed']) {
    assert.equal(await page.locator(selector).first().evaluate(el => getComputedStyle(el).color), 'rgb(235, 225, 205)');
  }
  await page.locator('[data-gutter] [data-line-type="change-addition"]').first().hover();
  await page.getByRole('button', { name: 'Add comment' }).click();
  await page.getByPlaceholder('Write a comment').fill('Keep this draft');
  await page.locator('[data-expand-button]').first().click();
  await page.getByText('four', { exact: true }).first().waitFor();
  await page.locator('.file-link[data-path="unavailable.txt"]').click();
  await page.locator('[data-expand-button]:visible').last().click();
  await page.getByText('Unchanged lines are unavailable for this file or snapshot. The original diff is still shown.').waitFor();
  assert.equal(await page.getByPlaceholder('Write a comment').inputValue(), 'Keep this draft');
  await page.getByRole('button', { name: 'Commits', exact: true }).click();
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  assert.equal(await page.getByPlaceholder('Write a comment').inputValue(), 'Keep this draft');
  await page.getByRole('button', { name: 'Queue comment' }).click();
  const queued = await page.evaluate(() => globalThis.queued);
  assert.match(queued[0][0], /Hub view: Changes/);
  assert.ok(queued[0][0].includes('b'.repeat(40)));
  assert.match(queued[0][0], /5: new/);
  await page.locator('.file-link[data-path="example.txt"]').click();
  await page.getByText('four', { exact: true }).first().hover();
  await page.getByRole('button', { name: 'Add comment' }).click();
  await page.getByPlaceholder('Write a comment').fill('Comment on expanded context');
  await page.getByRole('button', { name: 'Queue comment' }).click();
  const expanded = await page.evaluate(() => globalThis.queued[1]);
  assert.match(expanded[0], /4: four/);
  assert.equal(expanded[1].target.start, 4);
  assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Commits', exact: true }).click();
  assert.equal(await description.inputValue(), 'My draft');
  await page.getByRole('button', { name: 'Save description' }).click();
  await page.getByRole('alert').filter({ hasText: 'Conflict: stale' }).waitFor();
  assert.equal(await description.inputValue(), 'My draft');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  const tasks = page.getByRole('textbox', { name: 'Tasks Markdown', includeHidden: true });
  await page.locator('.hub-markdown input[type=checkbox]').first().check();
  await page.locator('.hub-markdown input[type=checkbox]').last().waitFor({ state: 'visible' });
  await page.locator('.hub-markdown input[type=checkbox]').last().check();
  await page.waitForFunction(() => { const boxes = [...document.querySelectorAll('.hub-markdown input[type=checkbox]')]; return boxes.length === 2 && boxes.every(box => box.checked && !box.disabled); });
  await assertEditButton(page.getByRole('button', { name: 'Edit Tasks Markdown' }), 'Edit Tasks Markdown');
  assert.equal(await tasks.evaluate(node => document.activeElement === node), true);
  assert.equal(await tasks.inputValue(), '- [x] Task\n\n> - [x] Quoted\n');
  await tasks.fill('- [x] Local draft\n');
  await page.getByRole('button', { name: 'Commits', exact: true }).click();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  assert.equal(await tasks.inputValue(), '- [x] Local draft\n');
  await tasks.press('Escape');
  assert.equal(await page.locator('.hub-markdown input[type=checkbox]').count(), 2);
  await page.getByRole('button', { name: 'Edit Tasks Markdown' }).click();
  assert.equal(await tasks.inputValue(), '- [x] Task\n\n> - [x] Quoted\n');
  assert.equal(await page.getByRole('button', { name: 'Add task' }).count(), 0);
});
