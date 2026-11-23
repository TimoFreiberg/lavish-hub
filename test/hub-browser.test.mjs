import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createHubTransport } from '../src/hub-transport.mjs';

test('hub actions work from the real Lavish opaque-origin iframe', { timeout: 120000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lavish-hub-browser-'));
  let calls = 0, browser;
  const assets = path.join(dir, 'published');
  await mkdir(assets);
  const published = path.join(assets, 'review.html');
  await writeFile(published, '<link rel="stylesheet" href="style.css"><script src="app.js"></script><p id="published">Published</p><img src="image.svg">');
  await writeFile(path.join(assets, 'style.css'), '#published { color: rgb(1, 2, 3) }');
  await writeFile(path.join(assets, 'app.js'), 'document.documentElement.dataset.loaded = "yes"');
  await writeFile(path.join(assets, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  await writeFile(path.join(dir, 'secret.txt'), 'outside');
  await symlink(path.join(dir, 'secret.txt'), path.join(assets, 'escape.txt'));
  const transport = await createHubTransport({ ping: () => { calls++; return { ok: true }; }, status: () => ({ available: true, selected: 'review' }), documents: () => ({ documents: [{ id: 'review', title: 'Review', source: published }] }), snapshot: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), commits: [] }) }, { resource: id => id === 'review' ? published : undefined });
  const resourceUrl = `${transport.url}/resources/${transport.resourceKey}/review/review.html`;
  const file = path.join(dir, 'hub.html');
  t.after(async () => {
    if (browser) await browser.close();
    try { execFileSync('lavish-axi', ['end', file], { stdio: 'ignore' }); } catch {}
    await transport.close();
    await rm(dir, { recursive: true, force: true });
  });
  const script = await readFile(new URL('../web/hub-app.mjs', import.meta.url), 'utf8');
  const config = JSON.stringify({ url: transport.url, capability: transport.capability, resourceKey: transport.resourceKey, workspace: 'test' });
  await writeFile(file, `<!doctype html><html><body>Hub action test<div id="app"></div><script>globalThis.hubConfig=${config}</script><script type="module">${script}</script></body></html>`);
  const output = execFileSync('lavish-axi', [file, '--no-open'], { encoding: 'utf8' });
  const url = output.match(/url:\s*"?(https?:\/\/[^"\s]+)/)?.[1];
  assert.ok(url, output);
  browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
  const page = await browser.newPage();
  await page.route('**/*', route => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.goto(url);
  const frame = page.locator('iframe').first().contentFrame();
  await frame.getByText('Hub action test').waitFor();
  const sandbox = await page.locator('iframe').first().getAttribute('sandbox');
  assert.ok(sandbox !== null && !sandbox.split(/\s+/).includes('allow-same-origin'));
  const result = await frame.locator('body').evaluate(async (_, { url, capability }) => {
    const request = async headers => {
      const response = await fetch(`${url}/action`, { method: 'POST', headers, body: JSON.stringify({ operation: 'ping' }) });
      return { status: response.status, body: await response.json() };
    };
    return { denied: await request({ 'content-type': 'application/json' }), allowed: await request({ 'content-type': 'application/json', 'x-lavish-capability': capability }) };
  }, { url: transport.url, capability: transport.capability });
  assert.equal(result.denied.status, 403);
  assert.equal(result.allowed.status, 200);
  assert.deepEqual(result.allowed.body.result, { ok: true });
  assert.equal(calls, 1);
  const publishedFrame = frame.locator('iframe[title="Review"]').contentFrame();
  await publishedFrame.locator('#published').waitFor();
  assert.equal(await publishedFrame.locator('html').getAttribute('data-loaded'), 'yes');
  assert.equal(await publishedFrame.locator('#published').evaluate(node => getComputedStyle(node).color), 'rgb(1, 2, 3)');
  assert.equal(await publishedFrame.locator('img').evaluate(node => node.complete && node.naturalWidth), 10);
  assert.equal((await fetch(new URL('escape.txt', resourceUrl))).status, 404);
  assert.equal((await fetch(`${transport.url}/resources/${transport.resourceKey}/review/%2e%2e%2fsecret.txt`)).status, 404);
  assert.equal((await fetch(`${transport.url}/resources/wrong/review/review.html`)).status, 403);
});
