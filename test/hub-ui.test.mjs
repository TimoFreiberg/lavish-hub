import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createHubTransport } from '../src/hub-transport.mjs';

test('hub keeps description drafts across navigation and stale saves', { timeout: 30000 }, async t => {
  const commit = { changeId: 'a'.repeat(32), commitId: 'b'.repeat(40), description: 'Original\n', immutable: false, divergent: false };
  const transport = await createHubTransport({
    status: () => ({ available: true }), documents: () => ({ documents: [] }), navigate: ({ id }) => ({ selected: id }),
    snapshot: () => ({ base: 'c'.repeat(40), head: 'b'.repeat(40), stat: '1 file changed', patch: 'diff content', commits: [commit] }),
    describe: () => ({ status: 'conflict', reason: 'stale', current: [{ description: 'External\n' }] }),
    readDocument: () => ({ text: '- [ ] Task\n', hash: 'hash', version: 'version' }),
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const page = await browser.newPage();
  await page.setContent(`<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: '/workspace' })}</script><script type="module">${script}</script>`);
  const description = page.getByRole('textbox', { name: /Description/ });
  await description.waitFor(); await description.fill('My draft');
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await page.getByText('diff content').waitFor();
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
