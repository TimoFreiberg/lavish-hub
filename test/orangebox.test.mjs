import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';
import { composeHubHtml } from '../src/hub-html.mjs';
import { renderMarkdown } from '../src/markdown.mjs';
import { palette, themeCss } from '../src/orangebox.mjs';

const require = createRequire(import.meta.url);

test('published HTML defaults to Orangebox without overriding authored styles or themes', async t => {
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  async function check(input) {
    await page.setContent(composeHubHtml(input, 'http://example.test/file.html', '<nav>Navigation</nav>'));
    return page.evaluate(() => ({ theme: document.documentElement.dataset.theme, background: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(document.body).color }));
  }
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    assert.deepEqual(await check('<html><head></head><body>Plain</body></html>'), { theme: 'orangebox', background: 'rgb(38, 33, 32)', color: 'rgb(235, 225, 205)' });
  }
  assert.deepEqual(await check('<html><head><style>body { background: white; color: black }</style></head><body>Authored</body></html>'), { theme: 'orangebox', background: 'rgb(255, 255, 255)', color: 'rgb(0, 0, 0)' });
  assert.deepEqual(await check('<html data-theme="custom"><head><style>body { background: pink; color: black }</style></head><body>Custom</body></html>'), { theme: 'custom', background: 'rgb(255, 192, 203)', color: 'rgb(0, 0, 0)' });
  assert.equal((await check('<p>Fragment</p>')).theme, 'orangebox');
});

test('Markdown uses the shared Shiki theme and palette tokens', async () => {
  const result = await renderMarkdown('```js\nconst n = 42; // hello\n```', { resolve: require.resolve });
  assert.match(result.body, /#F3A762/i);
  assert.match(result.body, /#D9A5BF/i);
  assert.match(result.body, /#A89A86/i);
  assert.match(result.body, /font-style:italic/i);
  assert.match(themeCss, /--color-base-300: #171412/);
  assert.equal(palette.border, '#463c36');
});
