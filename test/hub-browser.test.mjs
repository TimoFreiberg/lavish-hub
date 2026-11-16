import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createHubTransport } from '../src/hub-transport.mjs';

test('hub actions work from the real Lavish opaque-origin iframe', { timeout: 120000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lavish-hub-browser-'));
  let calls = 0, browser;
  const transport = await createHubTransport({ ping: () => { calls++; return { ok: true }; } });
  const file = path.join(dir, 'hub.html');
  t.after(async () => {
    if (browser) await browser.close();
    try { execFileSync('lavish-axi', ['end', file], { stdio: 'ignore' }); } catch {}
    await transport.close();
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(file, '<!doctype html><html><body>Hub action test</body></html>');
  const output = execFileSync('lavish-axi', [file, '--no-open'], { encoding: 'utf8' });
  const url = output.match(/url:\s*"?(https?:\/\/[^"\s]+)/)?.[1];
  assert.ok(url, output);
  browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
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
});
