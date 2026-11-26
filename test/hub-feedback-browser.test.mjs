import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import { createHubTransport } from '../src/hub-transport.mjs';

test('hub views do not add a feedback form', { timeout: 30000 }, async t => {
  const transport = await createHubTransport({
    status: () => ({ available: true }), documents: () => ({ documents: [{ id: 'review', title: 'Review', source: '/tmp/review.md' }] }),
    navigate: ({ id }) => ({ selected: id }), snapshot: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [], patch: '' }),
    readDocument: () => ({ text: '# Review\n', hash: 'hash', version: 'version' }),
  });
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(async () => { await browser.close(); await transport.close(); });
  const script = (await readFile(new URL('../web/hub-lifecycle.js', import.meta.url), 'utf8')) + '\n' + (await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8'));
  const markdown = (await build({ entryPoints: ['web/hub-markdown.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser' })).outputFiles[0].text;
  const page = await browser.newPage();
  await page.setContent(`<div id="app"></div><script>globalThis.hubConfig=${JSON.stringify({ url: transport.url, capability: transport.capability, workspace: 'test' })}; globalThis.mountLavishDiff=()=>({update(){},hide(){}})</script><script>${markdown.replaceAll('</script', '<\\/script')}</script><script type="module">${script}</script>`);
  for (const name of ['Commits', 'Changes', 'Tasks', 'Review']) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('heading', { name, exact: true }).first().waitFor();
    assert.equal(await page.getByRole('region', { name: 'Feedback' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: /^(Queue|Send) feedback$/ }).count(), 0);
  }
});
