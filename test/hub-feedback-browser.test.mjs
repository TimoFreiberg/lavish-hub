import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createHubTransport } from '../src/hub-transport.mjs';

test('hub feedback retains its originating view and revision across navigation and refresh', { timeout: 30000 }, async t => {
  let head = 'b'.repeat(40), selected = 'commits';
  const transport = await createHubTransport({
    status: () => ({ available: true, selected }), documents: () => ({ documents: [] }),
    navigate: ({ id }) => ({ selected: selected = id }),
    snapshot: () => ({ base: 'a'.repeat(40), head, commits: [], stat: '', patch: '' }),
    readDocument: () => ({ text: '', hash: 'hash', version: 'version' }),
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const page = await browser.newPage();
  await page.setContent(`<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}; globalThis.queued=[]; globalThis.lavish={queuePrompt:(...args)=>queued.push(args),sendQueuedPrompts:()=>{globalThis.sent=true}}</script><script type="module">${script}</script>`);
  await page.getByText('Connected', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await page.getByRole('heading', { name: 'Changes', exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Feedback' }).fill('Review this');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  head = 'c'.repeat(40);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText('Connected', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await page.getByRole('heading', { name: 'Changes', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Feedback' }).inputValue(), 'Review this');
  await page.getByRole('button', { name: 'Queue feedback' }).click();
  await page.getByRole('button', { name: 'Send feedback' }).click();
  const result = await page.evaluate(() => ({ queued, sent }));
  assert.match(result.queued[0][0], /Hub view: Changes \(changes\)/);
  assert.ok(result.queued[0][0].includes('b'.repeat(40)));
  assert.ok(!result.queued[0][0].includes('c'.repeat(40)));
  assert.match(result.queued[0][0], /Review this/);
  assert.equal(result.sent, true);
});
