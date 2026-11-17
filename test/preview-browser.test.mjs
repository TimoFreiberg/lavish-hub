import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
    browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
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
    await page.goto(`${base}hub-changes/page/index.html`);
    await page.locator('.hub-diff .sidebar').waitFor();
    await page.goto(`${base}hub-tasks/page/index.html`);
    await page.getByRole('textbox', { name: 'Tasks Markdown' }).fill('Preview edit');
    await page.goto(`${base}hub-conflict/page/index.html`);
    await page.getByRole('textbox', { name: /Description/ }).fill('Preview edit');
    await page.getByRole('button', { name: 'Save description' }).click();
    await page.getByText(/Conflict: changed on disk/).waitFor();
    assert.deepEqual(forbidden, []);
    assert.deepEqual(missing, []);
    assert.equal(await fixtureHash(), before);
  } finally {
    await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true });
  }
});
