import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { makePage } from '../scripts/visual/fixtures.mjs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

test('hub previews work without external requests or changing fixtures', async () => {
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
    for (const name of ['test/visual/fixtures', 'src', 'web']) await visit(name);
    return digest.digest('hex');
  };
  const before = await fixtureHash();
  try {
    execFileSync(process.execPath, ['scripts/preview.mjs', dir], { stdio: 'pipe' });
    server = createServer(async (req, res) => {
      try {
        const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/nested\//, '');
        const file = path.resolve(dir, name); if (!file.startsWith(`${dir}/`)) throw new Error('invalid path');
        const bytes = await readFile(file);
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
        res.end(bytes);
      } catch { res.statusCode = 404; res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/nested/`;
    browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const forbidden = [], missing = [];
    await context.route('**/*', route => {
      const request = route.request();
      if (!request.url().startsWith(base) || request.method() !== 'GET') {
        forbidden.push(`${request.method()} ${request.url()}`); return route.abort();
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
      await page.getByRole('complementary', { name: 'Preview controls' }).waitFor();
      await page.getByText('Connected', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => !!window.lavishPreview && window.lavish === window.lavishPreview), true);
    }
    await page.addInitScript(() => { window.Worker = class { constructor() { throw new Error('workers disabled'); } }; });
    await page.goto(`${base}hub-changes/page/index.html`);
    const sidebar = page.locator('.hub-diff .sidebar');
    await sidebar.getByRole('heading', { name: /Files \(/ }).waitFor();
    for (const width of [2200, 700]) {
      await page.setViewportSize({ width, height: 900 });
      const geometry = await page.evaluate(() => {
        const box = selector => document.querySelector(selector).getBoundingClientRect();
        return { main: box('#view').width, content: box('.hub-content').width, diff: box('.hub-diff').width, layout: box('.hub-diff .layout').width, sidebar: box('.hub-diff .sidebar').width, viewport: box('.hub-diff .viewport').width, document: document.documentElement.scrollWidth, width: innerWidth };
      });
      assert.ok(geometry.content - geometry.main < 2 && geometry.main - geometry.diff < 70, JSON.stringify(geometry));
      assert.ok(Math.abs(geometry.layout - geometry.diff) < 4 && geometry.viewport > geometry.layout - geometry.sidebar - 4, JSON.stringify(geometry));
      assert.ok(geometry.sidebar <= 282 && geometry.document <= geometry.width + 1, JSON.stringify(geometry));
      if (width === 2200) assert.ok(geometry.diff > 1700 && geometry.viewport > 1400, JSON.stringify(geometry));
    }
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.locator('.hub-diff').evaluate(node => { node.style.width = '580px'; });
    const headerGeometry = await page.locator('.hub-diff .file-header').first().evaluate(header => {
      const rect = node => node.getBoundingClientRect();
      const outer = rect(header), path = rect(header.querySelector('.path')), viewed = rect(header.querySelector('.viewed'));
      return { outer: { left: outer.left, right: outer.right }, path: { left: path.left, right: path.right, width: path.width }, viewed: { left: viewed.left, right: viewed.right, width: viewed.width } };
    });
    assert.ok(headerGeometry.path.width > 20 && headerGeometry.path.left >= headerGeometry.outer.left && headerGeometry.path.right <= headerGeometry.outer.right, JSON.stringify(headerGeometry));
    assert.ok(headerGeometry.viewed.width > 50 && headerGeometry.viewed.left >= headerGeometry.outer.left && headerGeometry.viewed.right <= headerGeometry.outer.right, JSON.stringify(headerGeometry));
    await page.locator('.hub-diff').evaluate(node => { node.style.width = ''; });
    const links = sidebar.locator('.file-link');
    assert.ok(await links.count() > 2);
    await links.nth(1).click();
    await page.keyboard.press('v');
    assert.match(await links.nth(1).innerText(), /✓/);
    await page.keyboard.press('j');
    await page.waitForFunction(() => document.querySelectorAll('.hub-diff .file-link')[2]?.getAttribute('aria-current') === 'true');
    await page.keyboard.press('?');
    assert.equal(await page.getByText('Keyboard shortcuts', { exact: true }).isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByText('Keyboard shortcuts', { exact: true }).isVisible(), false);
    await page.goto(`${base}hub-tasks/page/index.html`);
    await page.getByRole('button', { name: 'Edit Tasks Markdown' }).click();
    await page.getByRole('textbox', { name: 'Tasks Markdown' }).fill('Preview edit');
    await page.goto(`${base}hub-conflict/page/index.html`);
    await page.getByRole('button', { name: /Edit Description/ }).click();
    await page.getByRole('textbox', { name: /Description/ }).fill('Preview edit');
    await page.getByRole('button', { name: 'Save description' }).click();
    await page.getByText(/Conflict: changed on disk/).waitFor();
    const lines = Array.from({ length: 120 }, (_, i) => `+const line${i} = '${'x'.repeat(76)}';\n`).join('');
    const patch = Array.from({ length: 500 }, (_, i) => `diff --git a/folder/file${i}.js b/folder/file${i}.js\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/folder/file${i}.js\n@@ -0,0 +1,120 @@\n${lines}`).join('');
    assert.ok(Buffer.byteLength(patch) > 5_000_000);
    const dist = path.join(dir, 'build'); await mkdir(dist);
    execFileSync(process.execPath, ['build.mjs', process.cwd(), dist]);
    await makePage({ kind: 'hub', name: 'changes' }, path.join(dir, 'large'), dist, { patch }, { portable: true });
    const workerPage = await context.newPage();
    await workerPage.goto(`${base}large/page/index.html`);
    await workerPage.waitForFunction(() => [...document.querySelectorAll('.hub-diff *')].some(node => node.shadowRoot?.innerHTML.includes('#F3A762')), null, { timeout: 30000 });
    await workerPage.close();
    await page.goto(`${base}large/page/index.html`);
    await page.locator('.hub-diff .sidebar').getByRole('heading', { name: 'Files (500)' }).waitFor({ timeout: 30000 });
    await page.locator('.hub-diff [data-content] [data-line]').first().waitFor({ timeout: 30000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.hub-diff *')].some(node => node.shadowRoot?.innerHTML.includes('#F3A762')), null, { timeout: 30000 });
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ob-bg').trim()), '#262120');
    assert.ok(await page.locator('.hub-diff [data-content] [data-line]').count() < 6000);
    const folder = page.locator('.hub-diff .dir-row').first();
    await folder.focus();
    await page.keyboard.press('Enter');
    assert.equal(await folder.getAttribute('aria-expanded'), 'false');
    assert.equal(await folder.evaluate(node => document.activeElement === node), true);
    await page.keyboard.press('Enter');
    assert.equal(await folder.getAttribute('aria-expanded'), 'true');
    assert.equal(await folder.evaluate(node => document.activeElement === node), true);
    const filter = page.locator('.hub-diff .file-filter');
    await filter.evaluate(node => { window.originalFilter = node; });
    await filter.fill('file25');
    assert.equal(await filter.evaluate(node => node === window.originalFilter && document.activeElement === node), true);
    await filter.fill('');
    await page.locator('.hub-diff .file-link').nth(250).click();
    await page.locator('.hub-diff [data-file="folder/file250.js"]').waitFor();
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await page.waitForFunction(() => document.querySelector('.hub-diff .file-link[aria-current]')?.dataset.index === '252');
    await page.keyboard.press('k');
    await page.keyboard.press('n');
    await page.keyboard.press('n');
    await page.waitForFunction(() => document.querySelector('.hub-diff .file-link[aria-current]')?.dataset.index === '252');
    await page.locator('.hub-diff .file-link').nth(250).click();
    await page.locator('.hub-diff [data-file="folder/file250.js"]').waitFor();
    await page.keyboard.press('v');
    assert.match(await page.locator('.hub-diff .file-link').nth(250).innerText(), /✓/);
    assert.deepEqual(forbidden, []);
    assert.deepEqual(missing, []);
    assert.equal(await fixtureHash(), before);
  } finally {
    await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true });
  }
});
