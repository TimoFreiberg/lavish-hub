import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { createHubTransport } from '../src/hub-transport.mjs';
import { ensureHubAssets } from '../src/deps.mjs';
import path from 'node:path';

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
  const dist = await ensureHubAssets();
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const markdown = await readFile(path.join(dist, 'hub-markdown.js'), 'utf8');
  const page = await browser.newPage();
  await page.setContent(`<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, resourceKey: transport.resourceKey, workspace: 'test' })}</script><script>${markdown.replaceAll('</script', '<\\/script')}</script><script type="module">${script}</script>`);
  const area = page.getByRole('textbox', { name: 'Document Markdown' });
  await area.waitFor();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByRole('heading', { name: 'Review', level: 1 }).last().waitFor();
  await page.locator('.hub-markdown img').evaluate(image => image.decode());
  assert.equal(await page.locator('.hub-markdown img').evaluate(image => image.naturalWidth), 12);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await area.fill('# Draft\n');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Conflict: source changed').waitFor();
  assert.equal(await area.inputValue(), '# Draft\n');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByRole('heading', { name: 'Draft' }).waitFor();
});

test('hub keeps description drafts across navigation and stale saves', { timeout: 30000 }, async t => {
  const commit = { changeId: 'a'.repeat(32), commitId: 'b'.repeat(40), description: 'Original\n', immutable: false, divergent: false };
  const transport = await createHubTransport({
    status: () => ({ available: true }), documents: () => ({ documents: [] }), navigate: ({ id }) => ({ selected: id }),
    snapshot: () => ({ base: 'c'.repeat(40), head: 'b'.repeat(40), stat: '1 file changed', patch: 'diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-old\n+new\n', commits: [commit] }),
    describe: () => ({ status: 'conflict', reason: 'stale', current: [{ description: 'External\n' }] }),
    readDocument: () => ({ text: '- [ ] Task\n', hash: 'hash', version: 'version' }),
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const dist = await ensureHubAssets();
  const bundle = await readFile(path.join(dist, 'diff-app.js'), 'utf8');
  const css = await readFile(path.join(dist, 'diff.css'), 'utf8');
  const page = await browser.newPage();
  await page.setContent(`<html data-theme="light"><style>@scope (.hub-diff) { ${css} } .hub-diff { height: 600px; display: flex; flex-direction: column }</style><div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: '/workspace' })}; globalThis.queued=[]; globalThis.lavish={queuePrompt:(...args)=>queued.push(args),sendQueuedPrompts:()=>{throw new Error('send failed')}};</script><script>${bundle.replaceAll('</script', '<\\/script')}</script><script type="module">${script}</script>`);
  const description = page.getByRole('textbox', { name: /Description/ });
  await description.waitFor(); await description.fill('My draft');
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await page.locator('.file-link[data-path="example.txt"]').waitFor();
  for (const selector of ['.file-header .path', '.file-header .viewed']) {
    assert.equal(await page.locator(selector).first().evaluate(el => getComputedStyle(el).color), 'rgb(230, 237, 243)');
  }
  await page.locator('[data-gutter] [data-line-type="change-addition"]').first().hover();
  await page.getByRole('button', { name: 'Add comment' }).click();
  await page.getByPlaceholder('Write a comment').fill('Keep this draft');
  await page.getByRole('button', { name: 'Commits', exact: true }).click();
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  assert.equal(await page.getByPlaceholder('Write a comment').inputValue(), 'Keep this draft');
  await page.getByRole('button', { name: 'Queue comment' }).click();
  const queued = await page.evaluate(() => globalThis.queued);
  assert.match(queued[0][0], /Hub view: Changes/);
  assert.ok(queued[0][0].includes('b'.repeat(40)));
  assert.match(queued[0][0], /1: new/);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Could not send feedback: send failed').waitFor();
  await page.getByRole('button', { name: 'Commits', exact: true }).click();
  assert.equal(await description.inputValue(), 'My draft');
  await page.getByRole('button', { name: 'Save description' }).click();
  await page.getByRole('status').filter({ hasText: 'Conflict: stale' }).waitFor();
  assert.equal(await description.inputValue(), 'My draft');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  const tasks = page.getByRole('textbox', { name: 'Tasks Markdown' }); await tasks.fill('- [x] Local draft\n');
  await page.getByRole('button', { name: 'Commits', exact: true }).click();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  assert.equal(await tasks.inputValue(), '- [x] Local draft\n');
  await page.getByRole('checkbox', { name: 'Complete task 1' }).uncheck();
  await page.getByRole('textbox', { name: 'Task 1', exact: true }).fill('Edited task');
  assert.equal(await tasks.inputValue(), '- [ ] Edited task\n');
  await page.getByRole('button', { name: 'Add task' }).click();
  assert.equal(await tasks.inputValue(), '- [ ] Edited task\n- [ ] New task\n');
});
