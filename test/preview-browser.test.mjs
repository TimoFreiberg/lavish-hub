import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

test('preview simulates saves and conflicts without external requests', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'preview-browser-'));
  let browser, server;
  try {
    execFileSync(process.execPath, ['scripts/preview.mjs', dir], { stdio: 'pipe' });
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
    page.on('request', request => { if (!request.url().startsWith(base) || request.method() !== 'GET') forbidden.push(request.url()); });
    await page.goto(`${base}task-short-edit/page/index.html`);
    await page.locator('#editor').waitFor({ state: 'visible' });
    await page.locator('#editor').fill('First edit'); await page.locator('#save').click();
    await page.getByRole('status').filter({ hasText: 'Simulated save complete' }).waitFor();
    await page.getByText('Saved — up to date with disk').waitFor();
    await page.locator('#editor').fill('Second edit'); await page.locator('#preview-external').click();
    await page.locator('#keep').click(); await page.locator('#save').click();
    await page.getByText('Saved — up to date with disk').waitFor();
    assert.equal(await page.locator('#editor').inputValue(), 'Second edit');
    await page.goto(`${base}pr-unconfigured-rendered/page/index.html`);
    assert.equal(await page.locator('#create-pr').isDisabled(), true);
    assert.deepEqual(forbidden, []);
  } finally {
    await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true });
  }
});
