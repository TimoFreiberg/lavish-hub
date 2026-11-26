import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { createHubTransport } from '../src/hub-transport.mjs';

const bundle = async entry => (await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', platform: 'browser', define: { LAVISH_HUB_LANGUAGES: '[]' } })).outputFiles[0].text;

test('Markdown links reveal Changes and Commits, report unknown views, and retain drafts', { timeout: 45000 }, async t => {
  const changeId = 'abcdefgh12345678';
  const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -5 +5 @@\n-old\n+new\n' + 'diff --git a/long.txt b/long.txt\nnew file mode 100644\n--- /dev/null\n+++ b/long.txt\n@@ -0,0 +1,80 @@\n' + Array.from({ length: 80 }, (_, i) => `+line ${i}\n`).join('');
  const text = '[line](?view=changes&file=a.txt&line=2-3&side=old)\n\n[file](?view=changes&file=a.txt)\n\n[commit](?view=commits&change=abcdefgh)\n\n[ambiguous](?view=commits&change=abc)\n\n[missing commit](?view=commits&change=notfound)\n\n[missing file](?view=changes&file=%3Cimg%3E)\n\n[bounds](?view=changes&file=a.txt&line=99)\n\n[unknown](?view=missing)\n\n[external](https://example.com/)';
  let reads = 0;
  const transport = await createHubTransport({
    status: () => ({ available: true, selected: 'tasks' }), documents: () => ({ documents: [{ id: 'notes', title: 'Notes', source: 'notes.md' }] }),
    navigate: ({ id }) => ({ selected: id }),
    readDocument: () => ({ text, hash: 'h', version: 'v' }),
    snapshot: () => { return { operationId: 'op', version: 'v', base: 'a'.repeat(40), head: 'b'.repeat(40), patch, commits: [{ changeId, commitId: 'c'.repeat(40), description: 'description', stat: '' }, { changeId: 'abczzzzz12345678', commitId: 'd'.repeat(40), description: 'other', stat: '' }] }; },
    diffFiles: () => { reads++; return { oldFile: { name: 'a.txt', contents: 'one\ntwo\nthree\nfour\nold\n' }, newFile: { name: 'a.txt', contents: 'one\ntwo\nthree\nfour\nnew\n' } }; },
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const script = await readFile('web/hub-app.mjs', 'utf8'), css = await readFile('web/diff.css', 'utf8'), hubCss = await readFile('web/hub.css', 'utf8');
  const diff = await bundle('web/diff-app.mjs'), markdown = await bundle('web/hub-markdown.mjs');
  const page = await browser.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setContent(`<style>${hubCss} @scope (.hub-diff) { ${css} } .hub-diff { height: 180px; display: flex; flex-direction: column }</style><div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: '/workspace' })};</script><script>${diff.replaceAll('</script', '<\\/script')}</script><script>globalThis.reveals = 0; const mount = globalThis.mountLavishDiff; globalThis.mountLavishDiff = (...args) => { const instance = mount(...args); const reveal = instance.revealTarget; instance.revealTarget = target => { globalThis.reveals++; return reveal(target); }; return instance; };</script><script>${markdown.replaceAll('</script', '<\\/script')}</script><script>${script.replaceAll('</script', '<\\/script')}</script>`);
  const line = page.getByRole('link', { name: 'line' }); await line.waitFor();
  assert.equal(await line.getAttribute('data-lavish-action'), '');
  assert.equal(await page.getByRole('link', { name: 'external' }).getAttribute('data-lavish-action'), null);
  const intercepted = await line.evaluate(link => {
    let prevented;
    const stop = event => { prevented = event.defaultPrevented; event.preventDefault(); };
    document.addEventListener('click', stop, { once: true });
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    return prevented;
  });
  assert.equal(intercepted, false);
  const externalPrevented = await page.getByRole('link', { name: 'external' }).evaluate(link => {
    let prevented;
    document.addEventListener('click', event => { prevented = event.defaultPrevented; event.preventDefault(); }, { once: true });
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return prevented;
  });
  assert.equal(externalPrevented, false);
  await page.getByRole('button', { name: 'Edit Tasks Markdown' }).click();
  await page.getByRole('textbox', { name: 'Tasks Markdown' }).fill(text + '\n\nDraft');
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.getByRole('link', { name: 'commit', exact: true }).click();
  await page.locator(`.card[data-change-id="${changeId}"].deep-link-highlight`).waitFor();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  assert.match(await page.getByRole('textbox', { name: 'Tasks Markdown' }).inputValue(), /Draft/);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('link', { name: 'unknown' }).click();
  await page.getByText('Unknown view "missing".').waitFor();
  await page.getByRole('link', { name: 'line' }).click();
  await page.getByText('two', { exact: true }).first().waitFor({ timeout: 15000 });
  assert.equal(reads, 1);
  await page.locator('[data-line="2"][data-selected-line]').first().waitFor();
  await page.locator('[data-line="3"][data-selected-line]').first().waitFor();
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.locator('[data-deletions] [data-line="2"][data-selected-line]').first().waitFor();
  await page.locator('[data-deletions] [data-line="3"][data-selected-line]').first().waitFor();
  assert.equal(await page.evaluate(() => reveals), 1);
  const viewport = page.locator('.hub-diff .viewport');
  await viewport.hover();
  await page.mouse.wheel(0, 1000);
  await page.waitForFunction(() => document.querySelector('.hub-diff .viewport').scrollTop > 0);
  const scrollAfterUser = await viewport.evaluate(node => node.scrollTop);
  const refreshResponse = page.waitForResponse(response => response.url().endsWith('/action') && response.request().postData()?.includes('"snapshot"'));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await refreshResponse;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => reveals), 1);
  assert.equal(await viewport.evaluate(node => node.scrollTop), scrollAfterUser);
  await viewport.evaluate(node => { node.scrollTop = 0; });
  await page.getByRole('button', { name: 'Collapse a.txt' }).click();
  await page.locator('.file-header.is-collapsed').waitFor();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('link', { name: 'file', exact: true }).click();
  await page.locator('.file-header.deep-link-highlight:not(.is-collapsed)').waitFor();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('link', { name: 'commit', exact: true }).click();
  const highlighted = page.locator(`.card[data-change-id="${changeId}"].deep-link-highlight`);
  await highlighted.waitFor({ timeout: 15000 });
  assert.equal(await highlighted.evaluate(node => getComputedStyle(node).animationName), 'none');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('link', { name: 'ambiguous' }).click();
  await page.getByText(/Change prefix "abc" is ambiguous/).waitFor();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('link', { name: 'missing commit' }).click();
  await page.getByText('Commit "notfound" is not in the current snapshot.').waitFor();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('link', { name: 'missing file' }).click();
  await page.getByText('File "<img>" is not in the current diff.').waitFor();
  assert.equal(await page.locator('#view img').count(), 0);
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('link', { name: 'bounds' }).click();
  await page.getByText('Line 99 is outside a.txt (5 lines).').waitFor({ timeout: 15000 });
});

test('reveal reports unavailable expansion and added or deleted bounds', { timeout: 30000 }, async t => {
  const diff = await bundle('web/diff-app.mjs');
  const css = await readFile('web/diff.css', 'utf8');
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<style>${css}</style><div id="app" style="height:600px"></div><script>globalThis.hubConfig = {};</script><script>${diff.replaceAll('</script', '<\\/script')}</script>`);
  await page.evaluate(() => {
    globalThis.fileResult = null;
    globalThis.diff = mountLavishDiff(document.querySelector('#app'), { embedded: true, loadDiffFiles: async () => { if (!fileResult) throw new Error('unavailable'); return fileResult; } });
    globalThis.setPatch = patch => diff.update({ root: '/workspace', operationId: 'op', snapshotVersion: 'v', patch });
  });
  const modified = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -5 +5 @@\n-old\n+new\n';
  const added = 'diff --git a/add.txt b/add.txt\nnew file mode 100644\n--- /dev/null\n+++ b/add.txt\n@@ -0,0 +1 @@\n+new\n';
  const deleted = 'diff --git a/gone.txt b/other.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n';
  await page.evaluate(patch => setPatch(patch), modified);
  assert.deepEqual(await page.evaluate(() => diff.revealTarget({ file: 'a.txt', line: '2' })), { ok: false, reason: 'expansion-unavailable' });
  await page.evaluate(patch => setPatch(patch), added);
  assert.deepEqual(await page.evaluate(() => diff.revealTarget({ file: 'add.txt', line: '2' })), { ok: false, reason: 'line-out-of-bounds' });
  await page.evaluate(patch => setPatch(patch), deleted);
  assert.deepEqual(await page.evaluate(() => diff.revealTarget({ file: 'gone.txt', line: '1' })), { ok: true });
  await page.locator('[data-line="1"][data-selected-line]').first().waitFor();
  assert.deepEqual(await page.evaluate(() => diff.revealTarget({ file: 'gone.txt', line: '2' })), { ok: false, reason: 'line-out-of-bounds' });
  await page.evaluate(patch => { fileResult = { oldFile: { name: 'a.txt', contents: '' }, newFile: { name: 'a.txt', contents: 'new\n' } }; setPatch(patch); }, modified);
  assert.deepEqual(await page.evaluate(() => diff.revealTarget({ file: 'a.txt', line: '2', side: 'old' })), { ok: false, reason: 'line-out-of-bounds' });
  await page.getByText('Line 2 is outside a.txt (0 lines).').waitFor();
});

test('unknown initial view stays in hub when selected document is a sibling', { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(() => browser.close());
  const script = await readFile('web/hub-app.mjs', 'utf8');
  const page = await browser.newPage();
  await page.route('http://hub.test/**', route => {
    if (route.request().url().endsWith('/action')) {
      const { operation } = route.request().postDataJSON();
      const result = operation === 'status' ? { available: true, selected: 'review' }
        : operation === 'documents' ? { documents: [{ id: 'review', title: 'Review', source: 'review.html', sibling: 'review.html' }] }
          : { operationId: 'op', version: 'v', commits: [] };
      return route.fulfill({ json: { ok: true, result } });
    }
    return route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: 'http://hub.test', capability: 'test', workspace: '/workspace' })}</script><script>${script.replaceAll('</script', '<\\/script')}</script>` });
  });
  await page.goto('http://hub.test/hub.html?__lavish_hub_view=missing');
  await page.getByRole('status').filter({ hasText: 'Unknown view "missing".' }).waitFor({ timeout: 6000 });
  assert.equal(new URL(page.url()).pathname, '/hub.html');
  assert.equal(new URL(page.url()).searchParams.has('__lavish_hub_view'), false);
});
