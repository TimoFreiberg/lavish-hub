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
  const fixtures = 'test/visual/fixtures';
  const fixtureHash = async () => {
    const digest = createHash('sha256');
    for (const name of (await readdir(fixtures)).sort()) digest.update(name).update(await readFile(path.join(fixtures, name)));
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
    const page = await browser.newPage(); const forbidden = [];
    page.on('request', request => { if ((!request.url().startsWith(base) && !request.url().startsWith(`blob:${new URL(base).origin}/`)) || request.method() !== 'GET') forbidden.push(request.url()); });
    await page.goto(`${base}task-short-edit/page/index.html`);
    await page.locator('#editor').waitFor({ state: 'visible' });
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
    await page.locator('#editor').waitFor({ state: 'visible' });
    assert.notEqual(await page.locator('#editor').inputValue(), 'Second edit');
    await page.goto(`${base}pr-unconfigured-rendered/page/index.html`);
    assert.equal(await page.locator('#create-pr').isDisabled(), true);
    await page.goto(`${base}pr-configured-edit/page/index.html`);
    await page.locator('#editor').waitFor({ state: 'visible' });
    await page.locator('#pr-title').fill(''); await page.locator('#create-pr').click();
    assert.notEqual(await page.locator('#status').textContent(), 'Saved — up to date with disk');
    await page.locator('#pr-title').fill('Preview PR'); await page.locator('#create-pr').click();
    await page.getByText('Simulated Create PR acknowledged; no PR was created.').waitFor();
    await page.getByText('Saved — up to date with disk').waitFor();
    for (const id of ['html-document', 'diff-jj']) {
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
    await page.keyboard.press('s'); await page.getByRole('button', { name: 'Unified' }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(forbidden, []);
    assert.equal(await fixtureHash(), before);
  } finally {
    await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true });
  }
});
