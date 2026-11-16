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

async function assertEventually(check) {
  const deadline = Date.now() + 5000;
  while (true) {
    try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
  }
}
