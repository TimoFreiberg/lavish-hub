import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

test('preview simulates saves and conflicts without external requests', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'preview-browser-'));
  let browser, server;
  const fixtureHash = async () => {
    const digest = createHash('sha256');
    const visit = async dir => {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(name);
        else if (entry.isFile()) digest.update(name).update(await readFile(name));
      }
    };
    for (const dir of ['test/visual/fixtures', 'src', 'web']) await visit(dir);
    return digest.digest('hex');
  };
  const before = await fixtureHash();
  try {
    execFileSync(process.execPath, ['scripts/preview.mjs', dir], { stdio: 'pipe' });
    server = createServer(async (req, res) => {
      try {
        const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/nested\//, '');
        const file = path.resolve(dir, name); if (!file.startsWith(`${dir}/`)) throw new Error('invalid path');
        const bytes = await readFile(file); res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(bytes);
      } catch { res.statusCode = 404; res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/nested/`;
    browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
    const context = await browser.newContext({ hasTouch: true, serviceWorkers: 'block' });
    const forbidden = [], missing = [];
    await context.route('**/*', route => {
      const request = route.request();
      if (!request.url().startsWith(base) || request.method() !== 'GET') {
        forbidden.push(`${request.method()} ${request.url()}`);
        return route.abort();
      }
      return route.continue();
    });
    context.on('response', response => { if (!response.ok()) missing.push(`${response.status()} ${response.url()}`); });
    const page = await context.newPage();
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    for (const entry of manifest.pages) {
      await page.goto(`${base}index.html`);
      const link = page.locator(`a[href="${entry.url}"]`);
      assert.equal(await link.count(), 1, entry.id);
      await link.click();
      assert.equal(new URL(page.url()).pathname, new URL(entry.url, base).pathname, entry.id);
      await page.getByRole('complementary', { name: 'Preview controls' }).waitFor();
      assert.equal(await page.evaluate(() => !!window.lavishPreview && window.lavish === window.lavishPreview), true, `${entry.id} uses the preview adapter`);
      if (entry.kind === 'diff') {
        await page.locator('.sidebar').waitFor();
        if (entry.id !== 'diff-empty') await page.locator('[data-content] [data-line-type="change-addition"] span[style]').first().waitFor();
      } else if (entry.kind === 'task' || entry.kind === 'pr') {
        if (entry.id.includes('changed-on-disk')) await page.getByRole('button', { name: 'Keep mine' }).waitFor();
        else await page.getByRole('status').filter({ hasText: 'Up to date with disk' }).waitFor();
        if (entry.id.endsWith('-edit')) await page.locator('#editor').waitFor({ state: 'visible' });
        else await page.locator('#preview').waitFor({ state: 'visible' });
      } else await page.locator('h1').first().waitFor();
    }
    await page.goto(`${base}task-short-edit/page/index.html`);
    await page.locator('#editor').waitFor({ state: 'visible' });
    await page.getByRole('status').filter({ hasText: 'Up to date with disk' }).waitFor();
    const original = await page.locator('#editor').inputValue();
    assert.notEqual(original, '');
    await page.locator('#editor').fill('First edit'); await page.locator('#save').click();
    await page.getByRole('status').filter({ hasText: 'Simulated save complete' }).waitFor();
    await page.getByText('Saved — up to date with disk').waitFor();
    await page.locator('#editor').fill('Second edit'); await page.locator('#preview-external').click();
    await page.locator('#keep').click(); await page.locator('#save').click();
    await page.getByText('Saved — up to date with disk').waitFor();
    assert.equal(await page.locator('#editor').inputValue(), 'Second edit');
    await page.locator('#editor').fill('Discard this'); await page.locator('#preview-external').click();
    await page.locator('#reload').click();
    assert.match(await page.locator('#editor').inputValue(), /External fixture edit/);
    page.once('dialog', dialog => dialog.accept()); await page.locator('#preview-reset').click();
    await page.getByRole('status').filter({ hasText: 'Up to date with disk' }).waitFor();
    assert.equal(await page.locator('#editor').inputValue(), original);
    await page.locator('#editor').fill('Unsaved before theme change');
    page.once('dialog', dialog => dialog.accept());
    await page.getByLabel('Theme').selectOption('light');
    await page.waitForURL(/theme=light/);
    await page.getByRole('status').filter({ hasText: 'Up to date with disk' }).waitFor();
    assert.equal(await page.locator('#editor').inputValue(), original);
    await page.getByRole('link', { name: 'All previews' }).click();
    assert.match(page.url(), /index\.html\?theme=light/);
    await page.getByRole('link', { name: 'task-short-edit', exact: true }).click();
    assert.match(page.url(), /theme=light/);
    await page.getByRole('status').filter({ hasText: 'Up to date with disk' }).waitFor();
    assert.equal(await page.locator('#editor').inputValue(), original);
    await page.locator('#editor').fill('Unsaved before reload');
    page.once('dialog', dialog => dialog.accept()); await page.reload();
    await page.getByRole('status').filter({ hasText: 'Up to date with disk' }).waitFor();
    assert.equal(await page.locator('#editor').inputValue(), original);
    await page.goto(`${base}pr-unconfigured-rendered/page/index.html`);
    assert.equal(await page.locator('#create-pr').isDisabled(), true);
    await page.goto(`${base}pr-configured-edit/page/index.html`);
    await page.locator('#editor').waitFor({ state: 'visible' });
    await page.locator('#pr-title').fill(''); await page.locator('#create-pr').click();
    assert.equal(await page.locator('#status').textContent(), 'PR title must be a nonempty single line');
    assert.doesNotMatch(await page.locator('#preview-receipt').textContent(), /acknowledged/);
    await page.locator('#pr-title').fill('Preview PR'); await page.locator('#create-pr').click();
    await page.getByText('Simulated Create PR acknowledged; no PR was created.').waitFor();
    await page.getByText('Saved — up to date with disk').waitFor();
    await page.goto(`${base}diff-jj/page/index.html`);
    await page.locator('[data-content] [data-line-type="change-addition"] span[style]').first().waitFor();
    const addComment = async text => {
      await page.locator('[data-gutter] [data-line-type="change-addition"]').first().hover();
      await page.getByRole('button', { name: 'Add comment' }).click();
      await page.getByPlaceholder('Write a comment').fill(text);
      await page.getByRole('button', { name: 'Queue comment' }).click();
    };
    await page.evaluate(() => { const original = window.lavish.queuePrompt; window.lavish.queuePrompt = (...args) => { window.capturedComment = args; return original(...args); }; });
    const location = await (async () => {
      await page.locator('[data-gutter] [data-line-type="change-addition"]').first().hover();
      await page.getByRole('button', { name: 'Add comment' }).click();
      const where = await page.locator('.draft strong').textContent();
      await page.getByPlaceholder('Write a comment').fill('First comment');
      await page.getByRole('button', { name: 'Queue comment' }).click();
      return where;
    })();
    assert.match(location, /^new .+:\d+ \([a-f0-9]+\)$/);
    const captured = await page.evaluate(() => window.capturedComment);
    assert.ok(captured[0].includes(location));
    assert.match(captured[0], /First comment/);
    assert.equal(captured[1].tag, 'code-comment');
    assert.equal(await page.locator('#preview-queue li').count(), 1);
    assert.match(await page.locator('#preview-queue li').textContent(), new RegExp(location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await page.locator('#preview-queue button').click();
    assert.equal(await page.locator('#preview-queue li').count(), 0);
    await addComment('Discard on reset');
    page.once('dialog', dialog => dialog.accept()); await page.locator('#preview-reset').click();
    await page.locator('[data-content] [data-line-type="change-addition"] span[style]').first().waitFor();
    assert.equal(await page.locator('#preview-queue li').count(), 0);
    await addComment('Second comment');
    await page.locator('#preview-send').click();
    await page.getByText('Simulated comments sent; no action was run.').waitFor();
    assert.equal(await page.locator('#preview-queue li').count(), 0);
    const codeColors = [];
    for (const theme of ['dark', 'light']) {
      await page.goto(`${base}diff-jj/page/index.html?theme=${theme}`);
      const code = page.locator('[data-content] [data-line-type="change-addition"] span[style]').first();
      await code.waitFor();
      codeColors.push(await code.evaluate(el => getComputedStyle(el).color));
    }
    assert.notEqual(codeColors[0], codeColors[1], 'highlighted code uses theme colors');
    for (const id of ['html-document', 'markdown-document', 'task-short-edit', 'pr-configured-edit', 'diff-jj']) {
      const colors = [];
      for (const theme of ['dark', 'light']) {
        await page.goto(`${base}${id}/page/index.html?theme=${theme}`);
        if (id.startsWith('diff')) await page.locator('.file-link').first().waitFor();
        colors.push(await page.locator(id.startsWith('diff') ? '.sidebar' : 'body').evaluate(el => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor]));
      }
      assert.notDeepEqual(colors[0], colors[1], `${id} theme colors`);
    }
    await page.setViewportSize({ width: 480, height: 900 });
    await page.goto(`${base}diff-jj/page/index.html`);
    await page.locator('.file-link').first().waitFor();
    const files = page.locator('.file-link');
    assert.ok(await files.count() > 1);
    const target = await files.nth(1).getAttribute('data-path');
    await files.nth(1).click();
    assert.equal(await page.locator('.file-link[aria-current]').getAttribute('data-path'), target);
    await page.keyboard.press('s'); await page.getByRole('button', { name: 'Unified' }).waitFor();
    await page.keyboard.press('s'); await page.getByRole('button', { name: 'Split', exact: true }).waitFor();
    await page.getByRole('link', { name: /Open in Zed/ }).first().click();
    await page.getByText('Opening an editor is unavailable in the demo.').waitFor();
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: text => { window.copiedCommand = text; return Promise.resolve(); } } }));
    const copy = page.getByRole('button', { name: /Copy Zed command/ }).first();
    const copyDetails = await copy.evaluate(button => ({ path: button.closest('.file-header').dataset.file, line: button.getAttribute('aria-label').match(/:(\d+)$/)[1] }));
    await copy.click();
    assert.equal(await page.evaluate(() => window.copiedCommand), `zed '/example/repo/${copyDetails.path}:${copyDetails.line}'`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const touchTarget = async (selector) => {
      const control = page.locator(selector).first();
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 44, `${selector} touch target: ${JSON.stringify(box)}`);
      const hit = await control.evaluate((element, { x, y }) => element.contains(document.elementFromPoint(x, y)), { x: box.x + box.width / 2, y: box.y + box.height / 2 });
      assert.ok(hit, `${selector} must be the reachable control`);
    };
    for (const selector of ['#preview-reset', '#preview-send', '[aria-label="Theme"]', '.file-link', '.toolbar button']) await touchTarget(selector);
    await page.goto(`${base}markdown-document/page/index.html`);
    const paragraph = page.locator('p').filter({ hasText: 'AReallyLongUnbrokenIdentifier' });
    const wrapping = await paragraph.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      return { lines: range.getClientRects().length, right: element.getBoundingClientRect().right, width: document.documentElement.clientWidth };
    });
    assert.ok(wrapping.lines > 1 && wrapping.right <= wrapping.width, `long paragraph wraps within viewport: ${JSON.stringify(wrapping)}`);
    const codeScroll = await page.locator('pre').filter({ hasText: 'AReallyLongUnbrokenCodeLine' }).evaluate(element => {
      element.scrollLeft = element.scrollWidth;
      return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollLeft: element.scrollLeft };
    });
    assert.ok(codeScroll.scrollWidth > codeScroll.clientWidth && codeScroll.scrollLeft > 0, `long code line remains horizontally reachable: ${JSON.stringify(codeScroll)}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.goto(`${base}task-short-edit/page/index.html`);
    await page.locator('#editor').fill('Touch edit');
    await touchTarget('#save');
    await page.locator('#preview-external').click();
    for (const selector of ['#keep', '#reload']) await touchTarget(selector);
    await page.goto(`${base}pr-configured-edit/page/index.html`);
    await touchTarget('#create-pr');
    assert.deepEqual(forbidden, []);
    assert.deepEqual(missing, []);
    assert.equal(await fixtureHash(), before);
  } finally {
    await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true });
  }
});
