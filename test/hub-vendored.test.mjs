import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile, chmod } from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveWorkspace } from '../src/hub-workspace.mjs';
import { chromium } from 'playwright-core';

const run = promisify(execFile);
async function warmDeps(dir, env) {
  const npm = path.join(dir, 'npm');
  await writeFile(npm, '#!/bin/sh\nln -s "$FIXTURE" node_modules\n'); await chmod(npm, 0o700);
  const deps = new URL('../src/deps.mjs', import.meta.url).href;
  // Dependency installation and bundling are not part of hub startup checks.
  await run(process.execPath, ['--input-type=module', '-e', `import { ensureHubAssets } from ${JSON.stringify(deps)}; await ensureHubAssets();`], { env: { ...env, PATH: `${dir}:${env.PATH}`, FIXTURE: path.resolve('node_modules') }, timeout: 30000 });
}
test('published HTML reload preserves scroll and annotation drafts and protects authored edits', { timeout: 120000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-reload-'));
  const repo = path.join(dir, 'repo'), state = path.join(dir, 'state');
  await mkdir(repo); await mkdir(state); await run('jj', ['git', 'init', repo]);
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const env = { ...process.env, LAVISH_AXI_ALLOWED_HOSTS: '', LAVISH_AXI_STATE_DIR: state, LAVISH_AXI_PORT: String(port), XDG_DATA_HOME: path.join(dir, 'data'), XDG_STATE_HOME: path.join(dir, 'xdg') };
  delete env.HC_TERMINAL_ID;
  await warmDeps(dir, env);
  const identity = await resolveWorkspace(repo, env), runtime = path.join(identity.directory, 'owner', 'runtime.json');
  const child = spawn(process.execPath, [path.resolve('bin/lavish-hub'), 'listen', '--workspace', repo], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume();
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    try { await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) }); } catch {}
    await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 400; i++) { try { await stat(runtime); break; } catch { if (child.exitCode !== null) throw new Error(stderr); await delay(50); } }
  const url = stderr.match(/ready: (https?:\/\/\S+)/)?.[1]; assert.ok(url, stderr);
  const source = path.join(dir, 'review.html');
  const publish = async version => {
    await writeFile(source, `<!doctype html><html><body><div style="height:500px"></div><p id="note-target">Annotate this paragraph</p><p id="version-marker">${version}</p><label>Draft <input id="draft-field" value="initial"></label><div style="height:1500px"></div></body></html>`);
    await run(process.execPath, [path.resolve('bin/lavish-hub'), 'publish', source, '--id', 'review', '--title', 'Review', '--workspace', repo], { env });
  };
  await publish('v1');
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); const direct = new URL(url); direct.searchParams.set('view', 'review'); await page.goto(direct.href);
  const frame = page.frameLocator('#artifact'); await frame.locator('#version-marker').waitFor({ timeout: 20000 });
  const showAnyway = page.getByRole('button', { name: 'Show anyway' }); if (await showAnyway.isVisible()) await showAnyway.click();
  if (await page.locator('#annotation').getAttribute('aria-pressed') !== 'true') await page.locator('#annotation').click();
  await frame.locator('#note-target').evaluate(() => window.scrollTo(0, 500));
  await frame.locator('#note-target').click();
  const card = frame.locator('.lavish-annotation-card'); await card.locator('textarea').fill('keep this note');
  await delay(500); await publish('v2');
  await frame.locator('#version-marker').filter({ hasText: 'v2' }).waitFor({ timeout: 15000 });
  await card.locator('textarea').waitFor({ timeout: 10000 });
  assert.equal(await card.locator('textarea').inputValue(), 'keep this note');
  assert.ok(Math.abs(await frame.locator('#note-target').evaluate(() => window.scrollY) - 500) < 80);
  await frame.locator('#draft-field').fill('unsaved'); await publish('v3');
  const reload = frame.getByRole('button', { name: 'Reload updated document' }); await reload.waitFor({ timeout: 15000 });
  assert.equal(await frame.locator('#version-marker').textContent(), 'v2');
  assert.equal(await frame.locator('#draft-field').inputValue(), 'unsaved');
  assert.equal(await frame.locator('a[aria-current] .nav-badge-new').count(), 0);
  await frame.locator('#draft-field').fill('initial'); await frame.locator('#version-marker').filter({ hasText: 'v3' }).waitFor({ timeout: 15000 });
  await frame.locator('#draft-field').fill('unsaved-2'); await publish('v4'); await reload.waitFor({ timeout: 15000 });
  await reload.click(); await frame.locator('#version-marker').filter({ hasText: 'v4' }).waitFor({ timeout: 15000 });
});

test('hub opens with the vendored server rather than PATH and polls its protocol', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-vendored-'));
  const repo = path.join(dir, 'repo'), state = path.join(dir, 'state');
  await mkdir(repo); await mkdir(state);
  await run('jj', ['git', 'init', repo]);
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const trap = path.join(dir, 'lavish-axi');
  await writeFile(trap, `#!/bin/sh\ntouch "$PATH_TRAP"\nexit 1\n`); await chmod(trap, 0o700);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PATH_TRAP: path.join(dir, 'used'), LAVISH_AXI_ALLOWED_HOSTS: '', LAVISH_AXI_STATE_DIR: state, LAVISH_AXI_PORT: String(port), XDG_DATA_HOME: path.join(dir, 'data'), XDG_STATE_HOME: path.join(dir, 'xdg') };
  delete env.HC_TERMINAL_ID;
  try { await warmDeps(dir, env); } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  const identity = await resolveWorkspace(repo, env), runtime = path.join(identity.directory, 'owner', 'runtime.json');
  const child = spawn(process.execPath, [path.resolve('bin/lavish-hub'), 'listen', '--workspace', repo], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', stdout = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => { stdout += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    try { await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) }); } catch {}
    await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 400; i++) { try { await stat(runtime); break; } catch { if (child.exitCode !== null) throw new Error(stderr); await delay(50); } }
  const record = JSON.parse(await readFile(runtime, 'utf8'));
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.version, '0.1.98');
  assert.equal(health.lavish_hub_page_reviews, 1);
  assert.equal(health.lavish_hub_assets, 1);
  assert.equal(await realpath(health.state_dir), await realpath(state));
  assert.ok(record.page.endsWith('hub.html'));
  const localBase = `http://127.0.0.1:${port}`;
  const sessionKey = createHash('sha256').update(await realpath(record.page)).digest('hex').slice(0, 16);
  const proxyAction = `${localBase}/hub-proxy/${sessionKey}/action`;
  const actionHeaders = { 'content-type': 'application/json', 'x-lavish-capability': record.capability };
  const badHost = await new Promise((resolve, reject) => {
    const request = http.request(proxyAction, { method: 'POST', headers: { ...actionHeaders, host: 'example.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end('{"operation":"status"}');
  });
  assert.equal(badHost, 403);
  const badDashboardHost = await new Promise((resolve, reject) => {
    const request = http.request(`${localBase}/api/hubs`, { headers: { host: 'example.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(badDashboardHost, 403);
  assert.equal((await fetch(`${localBase}/api/hubs`, { headers: { 'x-forwarded-host': 'example.invalid' } })).status, 403);
  assert.equal((await fetch(proxyAction, { method: 'POST', headers: { ...actionHeaders, origin: 'http://example.invalid' }, body: '{"operation":"status"}' })).status, 403);
  assert.equal((await fetch(`${localBase}/api/hub-proxy/register`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'null' }, body: '{}' })).status, 403);
  await assert.rejects(stat(env.PATH_TRAP), { code: 'ENOENT' });
  const source = path.join(dir, 'review.html');
  await writeFile(source, '<!doctype html><html><head><link rel="stylesheet" href="review.css?v=1"></head><body><h1 id="authored">Published review</h1><input aria-label="Authored draft"><script src="review.js?v=2"></script></body></html>');
  await writeFile(path.join(dir, 'review.css'), '#authored { color: rgb(1, 2, 3) }');
  await writeFile(path.join(dir, 'review.js'), 'document.querySelector("#authored").dataset.ran="yes"');
  const publishOut = await run(process.execPath, [path.resolve('bin/lavish-hub'), 'publish', source, '--id', 'review', '--title', 'Review', '--workspace', repo], { env });
  const url = stderr.match(/ready: (https?:\/\/\S+)/)?.[1];
  assert.ok(url, stderr);
  assert.ok(publishOut.stdout.includes(`${url}?view=review`), publishOut.stdout);
  const initialStatus = await (await fetch(proxyAction, { method: 'POST', headers: actionHeaders, body: '{"operation":"status"}' })).json();
  assert.equal(initialStatus.result.selected, 'commits');
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(() => browser.close());
  const forward = net.createServer(socket => {
    const upstream = net.connect(port, '127.0.0.1');
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    socket.pipe(upstream).pipe(socket);
  });
  await new Promise(resolve => forward.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => forward.close(resolve)));
  const forwardedUrl = new URL(url);
  forwardedUrl.host = `127.0.0.1:${forward.address().port}`;
  const dashboard = await browser.newPage();
  await dashboard.route(`http://127.0.0.1:${port}/**`, route => route.abort());
  await dashboard.goto(new URL('/hubs', forwardedUrl).href);
  const hubLink = dashboard.getByRole('link', { name: 'repo' });
  await hubLink.waitFor();
  assert.equal(await hubLink.getAttribute('href'), `/session/${sessionKey}`);
  assert.equal(new URL(await hubLink.getAttribute('href'), dashboard.url()).port, String(forward.address().port));
  await dashboard.close();
  const page = await browser.newPage();
  await page.route(`http://127.0.0.1:${port}/**`, route => route.abort());
  await page.route(`${record.url}/**`, route => route.abort());
  const directReviewUrl = new URL(forwardedUrl.href);
  directReviewUrl.searchParams.set('view', 'review');
  await page.goto(directReviewUrl.href);
  const authored = page.frameLocator('#artifact').locator('#authored');
  await authored.waitFor({ timeout: 20000 });
  await page.waitForFunction(() => document.title === 'Review · repo · Lavish');
  const showAnyway = page.getByRole('button', { name: 'Show anyway' });
  if (await showAnyway.isVisible()) await showAnyway.click();
  assert.equal(await authored.getAttribute('data-ran'), 'yes');
  assert.equal(await authored.evaluate(node => getComputedStyle(node).color), 'rgb(1, 2, 3)');
  const resourceBase = await authored.evaluate(node => node.ownerDocument.querySelector('base').getAttribute('href'));
  const resourcePage = await browser.newPage();
  const resourceResponse = await resourcePage.goto(new URL(resourceBase, forwardedUrl).href);
  assert.match(resourceResponse.headers()['content-security-policy'], /^sandbox /);
  assert.equal(await resourcePage.evaluate(() => self.origin), 'null');
  assert.equal(await resourcePage.evaluate(() => { try { localStorage.getItem('test'); return false; } catch { return true; } }), true);
  await resourcePage.close();
  const publishedFrame = page.frameLocator('#artifact');
  const navBox = await publishedFrame.getByRole('navigation', { name: 'Hub navigation' }).boundingBox();
  const commitsBox = await publishedFrame.getByRole('link', { name: 'Commits', exact: true }).boundingBox();
  const changesBox = await publishedFrame.getByRole('link', { name: 'Changes', exact: true }).boundingBox();
  const authoredBox = await authored.boundingBox();
  assert.ok(navBox && commitsBox && changesBox && authoredBox);
  assert.ok(changesBox.y > commitsBox.y && authoredBox.x >= navBox.x + navBox.width);
  assert.match(page.frames().find(frame => frame.url().includes('document-'))?.url() || '', /document-.*\.html/);
  if (await page.locator('#annotation').getAttribute('aria-pressed') !== 'true') await page.locator('#annotation').click();
  const box = await authored.evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const frameBox = await page.locator('#artifact').boundingBox();
  assert.ok(frameBox);
  box.x += frameBox.x; box.y += frameBox.y;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 20 });
  await page.mouse.up();
  const card = page.frameLocator('#artifact').locator('.lavish-annotation-card');
  await card.locator('textarea').fill('Please revise this heading');
  await card.getByRole('button', { name: 'Queue' }).click();
  const replacement = path.join(dir, 'replacement.html');
  await writeFile(replacement, '<!doctype html><title>Replacement</title><p>Replacement document</p>');
  await page.frameLocator('#artifact').getByLabel('Authored draft').fill('Keep this form');
  await run(process.execPath, [path.resolve('bin/lavish-hub'), 'publish', replacement, '--id', 'review', '--title', 'Review', '--workspace', repo], { env });
  await page.getByRole('button', { name: 'Send to Agent', exact: true }).click();
  for (let i = 0; i < 200 && !stdout.includes('\n'); i++) await delay(50);
  assert.ok(stdout.includes('\n'), `No notification: ${stderr}`);
  const notification = JSON.parse(stdout.trim());
  assert.equal(notification.type, 'agent-notification');
  assert.equal(notification.page, record.page);
  assert.equal(notification.prompts.length, 1);
  assert.equal(notification.prompts[0].prompt, 'Please revise this heading');
  assert.equal(notification.prompts[0].text, 'Published review');
  assert.equal(notification.prompts[0].target.type, 'text-range');
  assert.equal(notification.prompts[0].document, await realpath(source));
  assert.equal(notification.snapshotDocument, await realpath(source));
  assert.equal(notification.snapshotPage, notification.prompts[0].page);
  assert.match(notification.context, /Published review/);
  const frame = page.frameLocator('#artifact');
  const commitsLink = frame.getByRole('link', { name: 'Commits', exact: true });
  await commitsLink.click();
  const dialog = frame.getByRole('dialog', { name: 'Leave with unsaved edits?' });
  await dialog.getByRole('button', { name: 'Keep editing' }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Keep editing' }).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape');
  assert.equal(await frame.getByLabel('Authored draft').inputValue(), 'Keep this form');
  assert.equal(await commitsLink.evaluate(el => el === document.activeElement), true);
  let navigateRequests = 0, mode = 'fail', requestStart = 0, requestDuration = 0;
  await page.route('**/action', async route => {
    if (route.request().postDataJSON()?.operation !== 'navigate') return route.continue();
    navigateRequests++;
    requestStart = performance.now();
    if (mode === 'fail') { await route.fulfill({ status: 503, body: 'unavailable' }); t.diagnostic(`Failed navigate response: ${(performance.now() - requestStart).toFixed(1)}ms`); return; }
    await delay(300);
    requestDuration = performance.now() - requestStart;
    await route.continue();
  });
  await commitsLink.click();
  await dialog.getByRole('button', { name: 'Leave page' }).click();
  const status = frame.getByRole('status');
  await status.getByText('Could not open Commits. Select it again to retry.').waitFor();
  assert.equal(navigateRequests, 1);
  assert.equal(await frame.getByRole('link', { name: 'Review', exact: true }).getAttribute('aria-current'), 'page');
  mode = 'delay';
  await commitsLink.click();
  await dialog.getByRole('button', { name: 'Leave page' }).click();
  await status.getByText('Opening Commits…').waitFor();
  await commitsLink.evaluate(el => el.click());
  await frame.getByRole('heading', { name: 'Commits', exact: true }).waitFor();
  assert.equal(navigateRequests, 2);
  await page.waitForFunction(() => document.querySelector('#annotation').getAttribute('aria-pressed') === 'false');
  await frame.getByRole('heading', { name: 'Commits', exact: true }).click();
  assert.equal(await frame.locator('.lavish-annotation-card').count(), 0);
  assert.equal(await frame.locator('#view').getAttribute('data-lavish-action'), null);
  await page.locator('#annotation').click();
  await frame.getByRole('button', { name: 'Refresh' }).click();
  assert.equal(await page.locator('#annotation').getAttribute('aria-pressed'), 'true');
  await frame.getByRole('heading', { name: 'Commits', exact: true }).click();
  await frame.locator('.lavish-annotation-card textarea').waitFor();
  await frame.locator('.lavish-annotation-card').getByRole('button', { name: 'Cancel' }).click();
  await page.locator('#annotation').click();
  assert.ok(requestDuration >= 280, `delayed request took ${requestDuration}ms`);
  t.diagnostic(`Injected navigate delay: ${requestDuration.toFixed(1)}ms`);
  await writeFile(path.join(repo, 'changed.txt'), `New line\n${Array.from({ length: 180 }, (_, i) => `Line ${i}`).join('\n')}\n`);
  await frame.getByRole('button', { name: 'Changes', exact: true }).click();
  await frame.locator('.file-link[data-path="changed.txt"]').waitFor();
  assert.equal(await frame.locator('#view').getAttribute('data-lavish-action'), null);
  await page.waitForFunction(() => document.querySelector('#annotation').getAttribute('aria-pressed') === 'false');
  await frame.getByRole('heading', { name: 'Changes', exact: true }).click();
  assert.equal(await frame.locator('.lavish-annotation-card').count(), 0);
  await page.locator('#annotation').click();
  await frame.getByRole('button', { name: 'Refresh' }).click();
  assert.equal(await page.locator('#annotation').getAttribute('aria-pressed'), 'true');
  await frame.getByRole('heading', { name: 'Changes', exact: true }).click();
  await frame.locator('.lavish-annotation-card textarea').waitFor();
  await frame.locator('.lavish-annotation-card').getByRole('button', { name: 'Cancel' }).click();
  await page.locator('#annotation').click();
  await frame.locator('[data-gutter] [data-line-type="change-addition"]').first().hover();
  await frame.getByRole('button', { name: 'Add comment' }).click();
  const comment = frame.getByPlaceholder('Write a comment');
  await comment.fill('Private queued diff comment');
  await frame.locator('body').evaluate(node => {
    const w = node.ownerDocument.defaultView;
    w.originalAcknowledgedQueue = w.lavish.queuePromptAcknowledged;
    w.lavish.queuePromptAcknowledged = async () => ({ status: 'rejected', reason: 'reserved' });
  });
  await frame.getByRole('button', { name: 'Queue comment' }).click();
  await frame.getByText('A send is reserved; finish or retry it before queueing. Your draft is retained.').waitFor();
  assert.equal(await comment.inputValue(), 'Private queued diff comment');
  for (const [reason, message] of [
    ['capacity', 'Too many queue requests are awaiting confirmation; finish them or reload the review. Your draft is retained.'],
    ['too_large', 'This comment or its quoted context is too large; select fewer lines or shorten it. Your draft is retained.'],
    ['rate_limited', 'Queueing is temporarily busy; wait a moment and retry. Your draft is retained.'],
  ]) {
    await frame.locator('body').evaluate((node, value) => { node.ownerDocument.defaultView.lavish.queuePromptAcknowledged = async () => ({ status: 'rejected', reason: value }); }, reason);
    await frame.getByRole('button', { name: 'Queue comment' }).click();
    await frame.getByText(message).waitFor();
  }
  await frame.locator('body').evaluate(node => {
    const w = node.ownerDocument.defaultView; let first = true;
    w.lavish.queuePromptAcknowledged = async (...args) => {
      const result = await w.originalAcknowledgedQueue(...args);
      if (first) { first = false; return { status: 'unknown' }; }
      return result;
    };
  });
  await frame.getByRole('button', { name: 'Queue comment' }).click();
  await frame.getByText('Queue confirmation is uncertain. Retry to check, or check the conversation before cancelling.').waitFor();
  assert.equal(await comment.inputValue(), 'Private queued diff comment');
  assert.equal(await comment.evaluate(node => node.readOnly), true);
  await frame.getByRole('button', { name: 'Queue comment' }).click();
  await comment.waitFor({ state: 'detached' });
  assert.equal(await page.locator('#queuedLog .bubble.queued').count(), 1);
  const overlay = page.locator('.diff-comment-card');
  await overlay.waitFor();
  assert.equal(await overlay.locator('.diff-comment-text').innerText(), 'Private queued diff comment');
  await page.waitForFunction(() => { const card = document.querySelector('.diff-comment-card'); return card && Number.parseFloat(card.style.height) < 80; });
  const shortHeight = await overlay.evaluate(node => node.getBoundingClientRect().height);
  assert.ok(shortHeight < 80);
  const pen = overlay.getByRole('button', { name: 'Edit queued diff comment' });
  assert.equal(await pen.getAttribute('title'), 'Edit queued diff comment');
  assert.equal(await pen.locator('svg').getAttribute('viewBox'), '0 0 24 24');
  assert.equal(await pen.locator('path').getAttribute('d'), 'M4 20l4-.8L19 8.2 15.8 5 4.8 16 4 20zm10.6-13.8l3.2 3.2');
  const panelPen = page.locator('#queuedLog .queued-edit');
  assert.equal(await panelPen.getAttribute('title'), 'Edit queued prompt');
  assert.equal(await panelPen.locator('path').getAttribute('d'), await pen.locator('path').getAttribute('d'));
  assert.doesNotMatch(await frame.locator('body').innerText(), /Private queued diff comment/);
  const overlayBox = await overlay.boundingBox(), artifactBox = await page.locator('#artifact').boundingBox();
  assert.ok(overlayBox && artifactBox && overlayBox.x >= artifactBox.x && overlayBox.y >= artifactBox.y && overlayBox.x + overlayBox.width <= artifactBox.x + artifactBox.width && overlayBox.y + overlayBox.height <= artifactBox.y + artifactBox.height);
  await overlay.getByRole('button', { name: 'Edit queued diff comment' }).click();
  const queuedEdit = page.getByRole('textbox', { name: 'Edit queued prompt' });
  assert.equal(await queuedEdit.inputValue(), 'Private queued diff comment');
  await queuedEdit.fill('Edited in chrome\nSecond line\nThird line');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction((height) => { const card = document.querySelector('.diff-comment-card'); return card && Number.parseFloat(card.style.height) > height; }, shortHeight);
  const multilineHeight = await overlay.evaluate(node => node.getBoundingClientRect().height);
  assert.ok(multilineHeight > shortHeight);
  await overlay.getByRole('button', { name: 'Edit queued diff comment' }).click();
  await queuedEdit.fill(`Edited in chrome\n${'Long comment '.repeat(120)}`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await overlay.getByText(/Edited in chrome/).waitFor();
  await page.waitForFunction((height) => { const card = document.querySelector('.diff-comment-card'); return card && Number.parseFloat(card.style.height) > height; }, multilineHeight);
  assert.ok(await overlay.evaluate(node => node.getBoundingClientRect().height) <= 320);
  await overlay.getByRole('button', { name: 'Edit queued diff comment' }).click();
  await queuedEdit.fill('Tiny');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction((height) => { const card = document.querySelector('.diff-comment-card'); return card && Number.parseFloat(card.style.height) < height; }, multilineHeight);
  assert.equal(await overlay.locator('.diff-comment-text').innerText(), 'Tiny');
  await frame.getByRole('button', { name: 'Split', exact: true }).click();
  await overlay.getByText('Tiny', { exact: true }).waitFor();
  await page.waitForFunction(() => { const card = document.querySelector('.diff-comment-card'); return card && Number.parseFloat(card.style.height) < 80; });
  assert.equal(await frame.locator('.queued-diff-slot').evaluate(node => node.getBoundingClientRect().height), await overlay.evaluate(node => node.getBoundingClientRect().height));
  await frame.getByRole('button', { name: 'Unified', exact: true }).click();
  await overlay.getByText('Tiny', { exact: true }).waitFor();
  await overlay.getByRole('button', { name: 'Edit queued diff comment' }).click();
  await queuedEdit.fill(`Edited in chrome\n${'Long comment '.repeat(120)}`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await overlay.getByText(/Edited in chrome/).waitFor();
  await page.reload();
  await overlay.getByText(/Edited in chrome/).waitFor();
  const originalViewport = page.viewportSize();
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.waitForFunction(() => { const card = document.querySelector('.diff-comment-card'); return card && Number.parseFloat(card.style.height) === 320; });
  assert.equal(await frame.locator('.queued-diff-slot').evaluate(node => node.getBoundingClientRect().height), 320);
  if (originalViewport) await page.setViewportSize(originalViewport);
  const commentText = overlay.locator('.diff-comment-text');
  await commentText.evaluate(node => { node.scrollTop = 40; });
  const editControl = overlay.getByRole('button', { name: 'Edit queued diff comment' });
  await editControl.focus();
  await page.evaluate(() => { window.savedDiffButton = document.activeElement; window.savedDiffCard = document.querySelector('.diff-comment-card'); window.savedDiffTop = window.savedDiffCard.getBoundingClientRect().top; });
  await frame.locator('.viewport').evaluate(node => { node.scrollTop += 25; });
  await page.waitForFunction(() => window.savedDiffCard.getBoundingClientRect().top !== window.savedDiffTop);
  assert.equal(await page.evaluate(() => document.activeElement === window.savedDiffButton && document.querySelector('.diff-comment-card') === window.savedDiffCard), true);
  assert.equal(await commentText.evaluate(node => node.scrollTop), 40);
  const headerBox = await frame.locator('.file-header').first().boundingBox();
  const viewportBox = await frame.locator('.viewport').boundingBox();
  const clippedBox = await page.locator('.diff-comment-clip').boundingBox();
  assert.ok(headerBox && viewportBox && clippedBox);
  assert.ok(headerBox.y <= viewportBox.y + 1 && headerBox.y + headerBox.height > viewportBox.y, 'expected the file header to be sticky');
  assert.ok(clippedBox.y >= headerBox.y + headerBox.height - 1, 'the comment must not cover the sticky header');
  await overlay.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true, pointerId: 77, clientX: 100, clientY: 200 });
  await page.locator('#diffCommentOverlay').dispatchEvent('pointermove', { pointerType: 'touch', pointerId: 77, clientX: 100, clientY: 150 });
  const touchScroll = await frame.locator('.viewport').evaluate(node => new Promise((resolve, reject) => {
    if (node.scrollTop > 25) return resolve(node.scrollTop);
    const timer = setTimeout(() => reject(new Error('touch did not reach the diff')), 5000);
    node.addEventListener('scroll', () => { clearTimeout(timer); resolve(node.scrollTop); }, { once: true });
  }));
  assert.ok(touchScroll > 25);
  await page.locator('#diffCommentOverlay').dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 77 });
  await frame.locator('.viewport').evaluate(node => { node.scrollTop = 0; });
  await overlay.waitFor();
  await commentText.evaluate(node => { node.scrollTop = node.scrollHeight; });
  const wheelBox = await commentText.boundingBox();
  assert.ok(wheelBox);
  await page.mouse.move(wheelBox.x + wheelBox.width / 2, wheelBox.y + wheelBox.height / 2);
  await page.mouse.wheel(0, 180);
  const moved = await frame.locator('.viewport').evaluate(node => new Promise((resolve, reject) => {
    if (node.scrollTop > 0) return resolve(node.scrollTop);
    const timer = setTimeout(() => reject(new Error('wheel did not reach the diff')), 5000);
    node.addEventListener('scroll', () => { clearTimeout(timer); resolve(node.scrollTop); }, { once: true });
  }));
  assert.ok(moved > 0);
  await frame.locator('.viewport').evaluate(node => { node.scrollTop = 0; });
  await overlay.waitFor();
  await frame.locator('.viewport').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.waitForFunction(() => document.querySelectorAll('.diff-comment-card').length === 0);
  await frame.locator('.viewport').evaluate(node => { node.scrollTop = 0; });
  await overlay.waitFor();
  await writeFile(path.join(repo, 'changed.txt'), 'New line\nAnother line\n');
  await frame.getByRole('button', { name: 'Refresh' }).click();
  await frame.getByText('Another line', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.diff-comment-card').length === 0);
  assert.match(await page.locator('#queuedLog').innerText(), /Edited in chrome/);
  await frame.locator('[data-gutter] [data-line-type="change-addition"]').first().hover();
  await frame.getByRole('button', { name: 'Add comment' }).click();
  await comment.fill('Keep this comment');
  await frame.getByRole('button', { name: 'Review', exact: true }).click();
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  assert.equal(await comment.inputValue(), 'Keep this comment');
  await frame.getByRole('button', { name: 'Review', exact: true }).click();
  await dialog.getByRole('button', { name: 'Leave page' }).click();
  await frame.getByText('Replacement document').waitFor();
  await page.waitForFunction(() => document.querySelector('#annotation').getAttribute('aria-pressed') === 'true');
  await page.unrouteAll();
  const normalStart = performance.now();
  let normalRequests = 0, normalResponse;
  page.on('response', response => {
    if (response.request().url().endsWith('/action') && response.request().postDataJSON()?.operation === 'navigate') {
      normalRequests++; normalResponse = performance.now();
    }
  });
  await frame.getByRole('link', { name: 'Commits', exact: true }).click();
  await frame.getByRole('heading', { name: 'Commits', exact: true }).waitFor();
  assert.equal(normalRequests, 1);
  t.diagnostic(`Normal click to navigate response: ${(normalResponse - normalStart).toFixed(1)}ms; click to Commits heading: ${(performance.now() - normalStart).toFixed(1)}ms`);
  const markdown = path.join(dir, 'notes.md');
  await writeFile(markdown, '# Notes\nOriginal\n');
  await run(process.execPath, [path.resolve('bin/lavish-hub'), 'publish', markdown, '--id', 'notes', '--title', 'Notes', '--attention', '--workspace', repo], { env });
  const notesButton = frame.getByRole('button', { name: 'Notes', exact: true });
  await notesButton.waitFor();
  assert.equal(await notesButton.getAttribute('data-attention'), 'true');
  assert.equal(await notesButton.getAttribute('aria-describedby'), 'hub-nav-desc-attention');
  assert.equal(await page.title(), 'Commits · repo · Lavish');
  // Opening a direct link in the same tab overrides any retained sibling destination in sessionStorage.
  // Also verify a transient acknowledge failure retries on the next poll while the rendered view stays open.
  let failedAck = false;
  const ackRoute = async route => {
    if (!failedAck && route.request().postDataJSON()?.operation === 'acknowledge') {
      failedAck = true;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'transient' }) });
      return;
    }
    await route.continue();
  };
  await page.route('**/action', ackRoute);
  const directNotesUrl = new URL(forwardedUrl.href);
  directNotesUrl.searchParams.set('view', 'notes');
  await page.goto(directNotesUrl.href);
  await frame.getByRole('button', { name: 'Edit Document Markdown' }).waitFor({ timeout: 20000 });
  await page.waitForFunction(() => document.title === 'Notes · repo · Lavish');
  await frame.locator('button[data-hub-id="notes"]:not([data-attention]):not([data-unseen])').waitFor({ timeout: 10000 });
  assert.equal(failedAck, true);
  await page.unroute('**/action', ackRoute);
  // Switching views after a direct link and reloading must stay on the manually chosen view.
  await frame.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.waitForFunction(() => document.title === 'Tasks · repo · Lavish');
  for (let i = 0; i < 40; i++) {
    const s = await (await fetch(proxyAction, { method: 'POST', headers: actionHeaders, body: '{"operation":"status"}' })).json();
    if (s.result?.selected === 'tasks') break;
    await delay(50);
  }
  await page.reload();
  await frame.getByRole('button', { name: 'Edit Tasks Markdown' }).waitFor({ timeout: 20000 });
  await page.waitForFunction(() => document.title === 'Tasks · repo · Lavish');
  await frame.getByRole('button', { name: 'Notes', exact: true }).click();
  await frame.getByRole('button', { name: 'Edit Document Markdown' }).waitFor({ timeout: 20000 });
  await frame.getByRole('button', { name: 'Edit Document Markdown' }).click();
  const editor = frame.getByRole('textbox', { name: 'Document Markdown' });
  await editor.waitFor();
  await editor.fill('# Notes\nSaved through the forward\n');
  await frame.getByRole('button', { name: 'Save', exact: true }).click();
  await frame.getByRole('button', { name: 'Edit Document Markdown' }).waitFor();
  assert.equal(await readFile(markdown, 'utf8'), '# Notes\nSaved through the forward\n');
  const hubsBackLink = page.getByRole('link', { name: 'Hubs', exact: true });
  assert.equal(await hubsBackLink.getAttribute('href'), '/hubs');
  await hubsBackLink.click();
  await page.waitForURL(new URL('/hubs', forwardedUrl).href);
  await page.getByRole('link', { name: 'repo' }).waitFor();
  await run(process.execPath, [path.resolve('bin/lavish-hub'), 'stop', '--workspace', repo], { env });
  const exit = child.exitCode === null ? await new Promise(resolve => child.once('exit', resolve)) : child.exitCode;
  assert.equal(exit, 0, stderr);
});

test('hub asset route grants narrow CORS to registered verified bundles', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-cors-'));
  const repo = path.join(dir, 'repo'), state = path.join(dir, 'state');
  await mkdir(repo); await mkdir(state); await run('jj', ['git', 'init', repo]);
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const env = { ...process.env, LAVISH_AXI_STATE_DIR: state, LAVISH_AXI_PORT: String(port), XDG_DATA_HOME: path.join(dir, 'data'), XDG_STATE_HOME: path.join(dir, 'xdg') };
  delete env.HC_TERMINAL_ID;
  try { await warmDeps(dir, env); } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  const cli = path.resolve('bin/lavish-hub');
  const identity = await resolveWorkspace(repo, env), runtime = path.join(identity.directory, 'owner', 'runtime.json');
  const child = spawn(process.execPath, [cli, 'listen', '--workspace', repo], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume();
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    try { await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) }); } catch {}
    await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 400; i++) { try { await stat(runtime); break; } catch { if (child.exitCode !== null) throw new Error(stderr); await delay(50); } }
  const record = JSON.parse(await readFile(runtime, 'utf8'));
  const localBase = `http://127.0.0.1:${port}`;
  const sessionKey = createHash('sha256').update(await realpath(record.page)).digest('hex').slice(0, 16);
  const html = await readFile(record.page, 'utf8');
  const bundles = [...html.matchAll(/src="(hub-asset-[a-f0-9]{64}\.js)"/g)].map(match => match[1]);
  assert.equal(bundles.length, 3);
  const stylesheet = html.match(/href="(hub-asset-[a-f0-9]{64}\.css)"/)[1];
  const source = path.join(dir, 'review.html');
  await writeFile(source, '<!doctype html><title>Review</title><p>Published</p>');
  await run(process.execPath, [cli, 'publish', source, '--id', 'review', '--title', 'Review', '--workspace', repo], { env });
  const sibling = `document-${createHash('sha256').update(JSON.stringify(['review', await realpath(source)])).digest('hex')}.html`;
  // The hub page loads its bundles from the opaque-origin artifact frame, so only
  // `Origin: null` is the caller that needs the grant, and only for a bundle.
  const request = (name, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const call = http.request(`${localBase}/artifact/${sessionKey}/${name}`, { method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => { chunks.push(chunk); });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    call.on('error', reject); call.end();
  });
  const allowed = 'access-control-allow-origin';
  const bundle = bundles[0];
  const served = await request(bundle, { headers: { origin: 'null', 'accept-encoding': 'identity' } });
  assert.equal(served.status, 200);
  assert.equal(served.headers[allowed], 'null');
  assert.match(String(served.headers.vary), /Origin/);
  assert.match(served.headers['content-type'], /javascript/);
  assert.match(served.headers['content-security-policy'], /^sandbox /);
  const head = await request(bundle, { method: 'HEAD', headers: { origin: 'null', 'accept-encoding': 'identity' } });
  assert.equal(head.status, 200);
  assert.equal(head.headers[allowed], 'null');
  assert.equal(head.body.length, 0);
  const fresh = await request(bundle, { headers: { origin: 'null', 'accept-encoding': 'identity', 'if-none-match': served.headers.etag } });
  assert.equal(fresh.status, 304);
  assert.equal(fresh.headers[allowed], 'null');
  assert.match(String(fresh.headers.vary), /Origin/);
  const encoded = await request(bundle, { headers: { origin: 'null', 'accept-encoding': 'gzip' } });
  assert.equal(encoded.status, 200);
  assert.equal(encoded.headers['content-encoding'], 'gzip');
  assert.equal(encoded.headers[allowed], 'null');
  // A variant that grants nothing still varies on Origin: a cache that kept it
  // without that would answer the frame with a body the browser then refuses.
  const anonymous = await request(bundle);
  assert.equal(anonymous.headers[allowed], undefined, 'a request without an origin gets no grant');
  assert.match(String(anonymous.headers.vary), /Origin/);
  const foreign = await request(bundle, { headers: { origin: 'http://example.invalid' } });
  assert.equal(foreign.headers[allowed], undefined, 'a foreign origin gets no grant');
  assert.match(String(foreign.headers.vary), /Origin/);
  const page = await request('hub.html', { headers: { origin: 'null' } });
  assert.equal(page.status, 200);
  assert.equal(page.headers[allowed], undefined, 'the hub page itself is not readable cross-origin');
  const published = await request(sibling, { headers: { origin: 'null' } });
  assert.equal(published.status, 200);
  assert.equal(published.headers[allowed], undefined, 'a generated document page is not readable cross-origin');
  const style = await request(stylesheet, { headers: { origin: 'null', 'accept-encoding': 'identity' } });
  assert.equal(style.status, 200);
  assert.equal(style.headers[allowed], undefined, 'only registered bundles are granted, not stylesheets');
  assert.equal((await request(bundle, { headers: { origin: 'null', range: 'bytes=0-9' } })).headers[allowed], undefined, 'a range of a bundle is not granted');
  assert.equal((await request(bundle, { headers: { origin: 'null', 'accept-encoding': 'identity;q=0' } })).headers[allowed], undefined, 'an unacceptable encoding is not granted');
  const stray = `hub-asset-${'0'.repeat(64)}.js`;
  await writeFile(path.join(identity.directory, stray), 'globalThis.strayBundle = true;');
  const unregistered = await request(stray, { headers: { origin: 'null', 'accept-encoding': 'identity' } });
  assert.equal(unregistered.status, 200);
  assert.equal(unregistered.headers[allowed], undefined, 'an unregistered bundle name is not granted');
  const original = await readFile(path.join(identity.directory, bundle));
  await writeFile(path.join(identity.directory, bundle), `/* replaced */\n${original}`);
  const tampered = await request(bundle, { headers: { origin: 'null', 'accept-encoding': 'identity' } });
  assert.equal(tampered.status, 200);
  assert.equal(tampered.headers[allowed], undefined, 'bytes that do not hash to the registered name are not granted');
  assert.notEqual(tampered.headers.etag, served.headers.etag);
  await writeFile(path.join(identity.directory, bundle), original);
  assert.equal((await request(bundle, { headers: { origin: 'null', 'accept-encoding': 'identity' } })).headers[allowed], 'null', 'restoring the bytes restores the grant');
  await run(process.execPath, [cli, 'stop', '--workspace', repo], { env });
  const exit = child.exitCode === null ? await new Promise(resolve => child.once('exit', resolve)) : child.exitCode;
  assert.equal(exit, 0, stderr);
  const ended = await request(bundle, { headers: { origin: 'null', 'accept-encoding': 'identity' } });
  // The session outlives the owner in the store, so the file still serves; what
  // the stopped owner takes with it is the registration that allowed the grant.
  assert.equal(ended.headers[allowed], undefined, 'an ended owner grants nothing');
});

test('CLI recovers published HTML after SIGKILL and refuses edited generated files', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-crash-'));
  const repo = path.join(dir, 'repo'), state = path.join(dir, 'state');
  await mkdir(repo); await mkdir(state); await run('jj', ['git', 'init', repo]);
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const env = { ...process.env, LAVISH_AXI_STATE_DIR: state, LAVISH_AXI_PORT: String(port), XDG_DATA_HOME: path.join(dir, 'data'), XDG_STATE_HOME: path.join(dir, 'xdg') };
  delete env.HC_TERMINAL_ID;
  try { await warmDeps(dir, env); } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  const cli = path.resolve('bin/lavish-hub');
  const identity = await resolveWorkspace(repo, env), runtime = path.join(identity.directory, 'owner', 'runtime.json');
  const children = [];
  const start = () => {
    const child = spawn(process.execPath, [cli, 'listen', '--workspace', repo], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.errors = ''; child.stderr.on('data', chunk => { child.errors += chunk; }); child.stdout.resume(); children.push(child); return child;
  };
  const waitReady = async child => {
    for (let i = 0; i < 400; i++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(child.errors);
      try { const record = JSON.parse(await readFile(runtime, 'utf8')); if (record.pid === child.pid) return; } catch {}
      await delay(50);
    }
    throw new Error(`Owner did not start: ${child.errors}`);
  };
  const kill = async child => { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited; };
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await kill(child);
    try { await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) }); } catch {}
    await rm(dir, { recursive: true, force: true });
  });
  const source = path.join(dir, 'review.html'); await writeFile(source, '<p>Crash recovery</p>');
  const first = start(); await waitReady(first);
  await run(process.execPath, [cli, 'publish', source, '--id', 'review', '--workspace', repo], { env });
  const name = `document-${createHash('sha256').update(JSON.stringify(['review', await realpath(source)])).digest('hex')}.html`;
  const sibling = path.join(identity.directory, name), registration = path.join(identity.directory, 'documents.json');
  const before = await readFile(registration, 'utf8');
  await kill(first);
  const second = start(); await waitReady(second);
  assert.match(await readFile(sibling, 'utf8'), /Crash recovery/);
  assert.equal(await readFile(registration, 'utf8'), before);
  await kill(second);
  await writeFile(sibling, 'User edit');
  const third = start();
  const code = await new Promise(resolve => third.once('exit', resolve));
  assert.notEqual(code, 0); assert.match(third.errors, /edited; refusing to overwrite/);
  assert.equal(await readFile(sibling, 'utf8'), 'User edit');
  assert.equal(await readFile(registration, 'utf8'), before);
});
