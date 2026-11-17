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
  const child = spawn(process.execPath, [path.resolve('bin/lavish-kit'), 'hub', 'listen', '--workspace', repo], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  assert.equal(health.version, '0.1.97');
  assert.equal(health.lavish_kit_page_reviews, 1);
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
  assert.equal((await fetch(proxyAction, { method: 'POST', headers: { ...actionHeaders, origin: 'http://example.invalid' }, body: '{"operation":"status"}' })).status, 403);
  assert.equal((await fetch(`${localBase}/api/hub-proxy/register`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'null' }, body: '{}' })).status, 403);
  await assert.rejects(stat(env.PATH_TRAP), { code: 'ENOENT' });
  const source = path.join(dir, 'review.html');
  await writeFile(source, '<!doctype html><html><head><link rel="stylesheet" href="review.css?v=1"></head><body><h1 id="authored">Published review</h1><input aria-label="Authored draft"><script src="review.js?v=2"></script></body></html>');
  await writeFile(path.join(dir, 'review.css'), '#authored { color: rgb(1, 2, 3) }');
  await writeFile(path.join(dir, 'review.js'), 'document.querySelector("#authored").dataset.ran="yes"');
  await run(process.execPath, [path.resolve('bin/lavish-kit'), 'hub', 'publish', source, '--id', 'review', '--title', 'Review', '--workspace', repo], { env });
  const url = stderr.match(/ready: (https?:\/\/\S+)/)?.[1];
  assert.ok(url, stderr);
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
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
  const page = await browser.newPage();
  await page.route(`http://127.0.0.1:${port}/**`, route => route.abort());
  await page.route(`${record.url}/**`, route => route.abort());
  await page.goto(forwardedUrl.href);
  const authored = page.frameLocator('#artifact').locator('#authored');
  await authored.waitFor({ timeout: 20000 });
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
  await run(process.execPath, [path.resolve('bin/lavish-kit'), 'hub', 'publish', replacement, '--id', 'review', '--title', 'Review', '--workspace', repo], { env });
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
  await frame.getByLabel('Authored draft').fill('Keep this form');
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
  assert.ok(requestDuration >= 300, `delayed request took ${requestDuration}ms`);
  t.diagnostic(`Injected navigate delay: ${requestDuration.toFixed(1)}ms`);
  await writeFile(path.join(repo, 'changed.txt'), 'New line\n');
  await frame.getByRole('button', { name: 'Changes', exact: true }).click();
  await frame.locator('.file-link[data-path="changed.txt"]').waitFor();
  await frame.locator('[data-gutter] [data-line-type="change-addition"]').first().hover();
  await frame.getByRole('button', { name: 'Add comment' }).click();
  const comment = frame.getByPlaceholder('Write a comment');
  await comment.fill('Keep this comment');
  await frame.getByRole('button', { name: 'Review', exact: true }).click();
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  assert.equal(await comment.inputValue(), 'Keep this comment');
  await frame.getByRole('button', { name: 'Review', exact: true }).click();
  await dialog.getByRole('button', { name: 'Leave page' }).click();
  await frame.getByText('Replacement document').waitFor();
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
  await run(process.execPath, [path.resolve('bin/lavish-kit'), 'hub', 'publish', markdown, '--id', 'notes', '--title', 'Notes', '--workspace', repo], { env });
  const editor = frame.getByRole('textbox', { name: 'Document Markdown' });
  await editor.waitFor();
  await editor.fill('# Notes\nSaved through the forward\n');
  await frame.getByRole('button', { name: 'Save', exact: true }).click();
  await frame.getByText('Saved', { exact: true }).waitFor();
  assert.equal(await readFile(markdown, 'utf8'), '# Notes\nSaved through the forward\n');
  await run(process.execPath, [path.resolve('bin/lavish-kit'), 'hub', 'stop', '--workspace', repo], { env });
  const exit = child.exitCode === null ? await new Promise(resolve => child.once('exit', resolve)) : child.exitCode;
  assert.equal(exit, 0, stderr);
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
  const cli = path.resolve('bin/lavish-kit');
  const identity = await resolveWorkspace(repo, env), runtime = path.join(identity.directory, 'owner', 'runtime.json');
  const children = [];
  const start = () => {
    const child = spawn(process.execPath, [cli, 'hub', 'listen', '--workspace', repo], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  await run(process.execPath, [cli, 'hub', 'publish', source, '--id', 'review', '--workspace', repo], { env });
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
