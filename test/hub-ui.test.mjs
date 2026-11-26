import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { createHubTransport } from '../src/hub-transport.mjs';
import { ensureHubAssets } from '../src/deps.mjs';
import path from 'node:path';
import { build } from 'esbuild';
const script = (await readFile(new URL('../web/hub-lifecycle.js', import.meta.url), 'utf8')) + '\n' + (await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8'));
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

test('hub sidebar hides and restores artifacts without acknowledging unread', { timeout: 30000 }, async t => {
  const doc = { id: 'review', title: 'Review', source: 'review.md', version: 'v1', viewedVersion: null, collapsed: false };
  let polls = 0;
  const other = { id: 'other', title: 'Other', source: 'other.md', version: 'v1', viewedVersion: 'v1', collapsed: false };
  const transport = await createHubTransport({
    status: () => ({ available: true, selected: 'commits' }), documents: () => { polls++; return { documents: [{ ...doc }, { ...other }] }; },
    snapshot: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [] }),
    navigate: ({ id }) => ({ selected: id }), readDocument: () => ({ text: '# Review', hash: 'h', version: 'v1' }),
    setDocumentCollapsed: ({ collapsed }) => { doc.collapsed = collapsed; return true; },
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const page = await browser.newPage({ viewport: { width: 500, height: 800 } });
  const css = await readFile(new URL('../web/hub.css', import.meta.url), 'utf8');
  await page.setContent(`<style>${css}</style><div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: '/workspace' })}</script><script type="module">${script}</script>`);
  const hide = page.getByRole('button', { name: 'Hide Review' });
  await hide.focus(); await hide.press('Enter');
  const details = page.locator('.nav-older');
  await page.waitForFunction(() => document.querySelector('.nav-older-count')?.textContent === '1');
  assert.equal(await details.locator('summary').evaluate(el => document.activeElement === el), true);
  await details.locator('summary').press('Enter');
  assert.equal(await details.locator('[data-unseen]').count(), 1);
  const layout = await page.evaluate(() => { const nav = document.querySelector('#navigation'), primary = nav.querySelector('.nav-primary'), older = nav.querySelector('.nav-older'); const p = primary.getBoundingClientRect(), o = older.getBoundingClientRect(), n = nav.getBoundingClientRect(); return { direction: getComputedStyle(nav).flexDirection, scroll: getComputedStyle(primary).overflowX, below: o.top >= p.bottom - 1, fits: o.right <= n.right + 1 && o.left >= n.left - 1 }; });
  assert.deepEqual(layout, { direction: 'column', scroll: 'auto', below: true, fits: true });
  const restore = page.getByRole('button', { name: 'Restore Review' });
  await restore.focus(); await restore.press('Enter');
  await page.waitForFunction(() => document.querySelector('[aria-label="Hide Review"]') === document.activeElement);
  assert.equal(doc.collapsed, false); assert.equal(doc.viewedVersion, null);
  await details.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-hub-id="review"]')?.getAttribute('aria-current') === 'page');
  await page.getByRole('button', { name: 'Hide Review' }).click();
  await page.waitForFunction(() => document.querySelector('.nav-older')?.open);
  await details.locator('summary').click();
  assert.equal(await details.getAttribute('open'), null);
  await page.evaluate(() => { globalThis.previousIcon = document.querySelector('[aria-label="Hide Other"] svg'); });
  const previousPolls = polls;
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.ok(polls > previousPolls);
  assert.equal(await page.evaluate(() => globalThis.previousIcon === document.querySelector('[aria-label="Hide Other"] svg')), true);
  assert.equal(await details.getAttribute('open'), null);
  const otherToggle = page.getByRole('button', { name: 'Hide Other' });
  await otherToggle.focus();
  other.collapsed = true;
  await page.waitForFunction(() => document.querySelector('.nav-older [aria-label="Restore Other"]'));
  assert.equal(await details.locator('summary').evaluate(el => document.activeElement === el), true);
  assert.equal(await details.getAttribute('open'), null);
});

test('hub sidebar defers auto-collapse while reading and omits toggle without version', { timeout: 30000 }, async t => {
  const outdated = { id: 'outdated', title: 'Outdated', source: 'outdated.md', version: 'v1', viewedVersion: null, collapsed: false };
  const versionless = { id: 'fixture', title: 'Fixture', source: 'fixture.md', collapsed: false };
  let polls = 0;
  const transport = await createHubTransport({
    status: () => ({ available: true, selected: 'commits' }),
    documents: () => { polls++; return { documents: [{ ...outdated }, { ...versionless }] }; },
    snapshot: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [] }),
    navigate: ({ id }) => ({ selected: id }),
    acknowledge: ({ id, version }) => {
      if (id === outdated.id && version === outdated.version) { outdated.viewedVersion = version; outdated.collapsed = true; }
      return true;
    },
    readDocument: () => ({ text: '# Outdated', hash: 'h', version: 'v1' }),
    setDocumentCollapsed: ({ collapsed }) => { outdated.collapsed = collapsed; return true; },
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const page = await browser.newPage();
  await page.setContent(`<div id="app"></div><script>${await markdownBundle()}</script><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: '/workspace' })}</script><script type="module">${script}</script>`);
  await page.getByRole('button', { name: 'Outdated', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Hide Fixture' }).count(), 0);
  await page.getByRole('button', { name: 'Outdated', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-hub-id="outdated"]')?.getAttribute('aria-current') === 'page');
  const afterOpen = polls;
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.ok(polls > afterOpen);
  assert.equal(outdated.collapsed, true);
  assert.equal(await page.locator('.nav-primary [data-hub-id="outdated"]').count(), 1);
  assert.equal(await page.locator('.nav-older').isVisible(), false);
  await page.getByRole('button', { name: 'Commits', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.nav-older [data-hub-id="outdated"]'));
  assert.equal(await page.locator('.nav-older-count').textContent(), '1');
  assert.equal(await page.locator('.nav-older').getAttribute('open'), null);
});

test('sidebar uses workspace name until a session title is set', { timeout: 30000 }, async t => {
  let title = '';
  const transport = await createHubTransport({
    status: () => ({ available: true, selected: 'commits', title }), documents: () => ({ documents: [] }),
    snapshot: () => ({ operationId: 'd'.repeat(128), base: 'c'.repeat(40), head: 'b'.repeat(40), stat: '', patch: '', commits: [] }),
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const page = await browser.newPage();
  await page.setContent(`<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: '/workspace/child', workspaceName: 'child', repoName: 'repo' })}; globalThis.lavish={setDocumentMeta: value => { globalThis.metaTitle=value.title; }};</script><script type="module">${script}</script>`);
  await page.getByRole('heading', { name: 'Commits' }).waitFor();
  assert.equal(await page.locator('.hub-repo-name').textContent(), 'child');
  assert.equal(await page.locator('.hub-session-title').isVisible(), false);
  await page.waitForFunction(() => document.title === 'repo');
  title = 'Review one';
  await page.waitForFunction(() => document.querySelector('.hub-session-title').textContent === 'Review one');
  assert.equal(await page.locator('.hub-session-title').isVisible(), true);
  assert.equal(await page.locator('.hub-repo-name').textContent(), 'repo');
  assert.equal(await page.title(), 'Review one');
  assert.equal(await page.evaluate(() => globalThis.metaTitle), 'Review one');
  title = '';
  await page.waitForFunction(() => document.title === 'repo');
  assert.equal(await page.locator('.hub-repo-name').textContent(), 'child');
  assert.equal(await page.locator('.hub-session-title').isVisible(), false);
});

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
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); await rm(dir, { recursive: true, force: true }); });
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
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const dist = await ensureHubAssets();
  const bundle = (await build({ entryPoints: ['web/diff-app.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser', define: { LAVISH_HUB_LANGUAGES: '[]' } })).outputFiles[0].text;
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

test('hub gives up on a navigation the owner never answers and lets the next one through', { timeout: 40000 }, async t => {
  const navigations = [];
  const transport = await createHubTransport({
    status: () => ({ available: true }), documents: () => ({ documents: [] }),
    snapshot: () => ({ operationId: 'd'.repeat(128), base: 'c'.repeat(40), head: 'b'.repeat(40), stat: '', patch: '', commits: [] }),
    // A request lost in transit looks like this to the page: it is never answered.
    navigate: ({ id }) => { navigations.push(id); return navigations.length === 1 ? new Promise(() => {}) : { selected: id }; },
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const bundle = (await build({ entryPoints: ['web/diff-app.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser', define: { LAVISH_HUB_LANGUAGES: '[]' } })).outputFiles[0].text;
  const markdown = await markdownBundle();
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.setContent(`<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: '/workspace' })};</script><script>${bundle.replaceAll('</script', '<\\/script')}</script><script>${markdown.replaceAll('</script', '<\\/script')}</script><script type="module">${script}</script>`);
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await page.getByText('Hub actions are unreachable.', { exact: false }).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Commits', exact: true }).click();
  for (const deadline = Date.now() + 5000; navigations.length < 2 && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(navigations, ['changes', 'commits']);
  await page.locator('#navigation [aria-current="page"]', { hasText: 'Commits' }).waitFor();
  await page.getByText('Hub actions are unreachable.', { exact: false }).waitFor({ state: 'detached' });
});

test('hub reloads itself when a restarted owner rejects its access token', { timeout: 40000 }, async t => {
  const transport = await createHubTransport({ status: () => ({ available: true }), documents: () => ({ documents: [] }), snapshot: () => ({ operationId: 'd'.repeat(128), base: 'c'.repeat(40), head: 'b'.repeat(40), stat: '', patch: '', commits: [] }) });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const bundle = (await build({ entryPoints: ['web/diff-app.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser', define: { LAVISH_HUB_LANGUAGES: '[]' } })).outputFiles[0].text;
  const markdown = await markdownBundle();
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  // The page was generated for the previous owner, so its token no longer matches.
  await page.setContent(`<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: 'e'.repeat(64), workspace: '/workspace' })};</script><script>${bundle.replaceAll('</script', '<\\/script')}</script><script>${markdown.replaceAll('</script', '<\\/script')}</script><script type="module">${script}</script>`);
  await page.getByText('The hub owner restarted.', { exact: false }).waitFor();
  // Once it has been open long enough to rule out a reload loop, it reloads.
  await page.waitForEvent('framenavigated', { timeout: 20000 });
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
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const dist = await ensureHubAssets();
  const bundle = (await build({ entryPoints: ['web/diff-app.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser', define: { LAVISH_HUB_LANGUAGES: '[]' } })).outputFiles[0].text;
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
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const dist = await ensureHubAssets();
  const bundle = (await build({ entryPoints: ['web/diff-app.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser', define: { LAVISH_HUB_LANGUAGES: '[]' } })).outputFiles[0].text;
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
