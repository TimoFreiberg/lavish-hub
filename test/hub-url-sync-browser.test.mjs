import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { resolveWorkspace } from '../src/hub-workspace.mjs';

const exec = promisify(execFile), cli = path.resolve('bin/lavish-hub');
let dir, repo, env, owner, ownerExit, browser, url, connection, port;
const run = async (command, args) => (await exec(command, args, { env, timeout: 30000 })).stdout;
async function until(fn, message = 'condition', timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await delay(100); }
  throw new Error(`Timed out waiting for ${message}`);
}
async function request(operation) {
  const response = await fetch(`${connection.url}/action`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lavish-capability': connection.capability }, body: JSON.stringify({ operation }) });
  assert.equal(response.status, 200);
  return (await response.json()).result;
}
const frame = page => page.frameLocator('#artifact');
async function open(page, suffix = '?view=commits') {
  await page.goto(url + suffix);
  await frame(page).locator('#lavish-hub-sidebar, #app').first().waitFor({ timeout: 20000 });
}
async function current(page, id, hash = '') {
  await until(() => { const u = new URL(page.url()); return u.searchParams.get('view') === id && u.hash === hash; }, `URL ${id}${hash}`);
  await until(async () => (await request('status')).selected === id, `owner selection ${id}`);
}
async function ready(page, id) {
  const marker = id === 'review' ? frame(page).getByRole('heading', { name: 'Review page' }) : frame(page).locator('#app');
  await marker.waitFor({ timeout: 20000 });
  if (id === 'note') await frame(page).locator('#view').getByRole('link', { name: 'Go to section' }).waitFor();
  await until(async () => { try { return await marker.evaluate(async () => await globalThis.lavish?.setAnnotationMode(false)); } catch { return false; } }, 'authenticated frame');
}
async function select(page, label, id) {
  await frame(page).getByRole('button', { name: label, exact: true }).or(frame(page).getByRole('link', { name: label, exact: true })).first().click();
  await current(page, id); await ready(page, id);
}
async function go(page, direction, id, hash = '') {
  await page.evaluate(direction => history[direction](), direction);
  await current(page, id, hash); await ready(page, id);
}
async function targetVisible(page) {
  await frame(page).locator('#section').waitFor();
  await until(async () => frame(page).locator('#section').evaluate(el => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight / 2; }), 'fragment scroll');
}
async function explore(page) {
  if (await page.locator('#annotation').getAttribute('aria-pressed') === 'true') await page.locator('#annotation').click();
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'hub-url-browser-'));
  repo = path.join(dir, 'repo'); const state = path.join(dir, 'state');
  env = { ...process.env, LAVISH_AXI_STATE_DIR: state, XDG_DATA_HOME: path.join(dir, 'data'), XDG_STATE_HOME: path.join(dir, 'xdg') };
  await mkdir(repo); await mkdir(state); await run('jj', ['git', 'init', repo]);
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  port = socket.address().port; await new Promise(resolve => socket.close(resolve)); env.LAVISH_AXI_PORT = String(port);
  const identity = await resolveWorkspace(repo, env), runtime = path.join(identity.directory, 'owner', 'runtime.json');
  owner = spawn(process.execPath, [cli, 'listen', '--workspace', repo], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; owner.stdout.resume(); owner.stderr.on('data', data => { stderr += data; });
  ownerExit = new Promise(resolve => owner.once('exit', resolve));
  connection = await until(async () => { try { return JSON.parse(await readFile(runtime, 'utf8')); } catch { return null; } }, 'owner');
  const md = path.join(dir, 'note.md'), html = path.join(dir, 'review.html');
  await writeFile(md, '# Note\n\n[Go to section](#section)\n\n' + 'Paragraph of text.\n\n'.repeat(100) + '## Section\n\nTarget.\n\n' + 'More text.\n\n'.repeat(80));
  await writeFile(html, '<!doctype html><html><head><title>Review</title><base href="./"></head><body><h1>Review page</h1><a href="#section">Go to section</a><input aria-label="Frame draft"><div style="height:1800px"></div><h2 id="section">Section</h2><div style="height:1200px"></div></body></html>');
  await run(process.execPath, [cli, 'publish', md, '--id', 'note', '--title', 'Note', '--workspace', repo]);
  await run(process.execPath, [cli, 'publish', html, '--id', 'review', '--title', 'Review', '--workspace', repo]);
  url = (await until(() => stderr.match(/ready: (https?:\/\/\S+)/), 'session URL'))[1];
  browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
});
after(async () => {
  await browser?.close();
  if (owner && owner.exitCode === null && owner.signalCode === null) { owner.kill('SIGTERM'); await Promise.race([ownerExit, delay(5000)]); if (owner.exitCode === null && owner.signalCode === null) { owner.kill('SIGKILL'); await ownerExit; } }
  if (port) { try { await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) }); } catch {} }
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('initial load writes ?view=ID via replaceState and preserves explicit ?view=ID', { timeout: 60000 }, async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  await page.goto('about:blank'); await page.goto(url);
  await until(() => new URL(page.url()).searchParams.has('view'), 'initial URL');
  assert.equal(await page.evaluate(() => history.length), 2);
  await open(page, '?view=tasks'); await current(page, 'tasks');
  assert.equal(new URL(page.url()).searchParams.get('view'), 'tasks');
});

test('sidebar navigation syncs top-level ?view=ID across built-ins, Markdown, and HTML siblings', { timeout: 60000 }, async t => {
  const page = await browser.newPage(); t.after(() => page.close()); await open(page);
  for (const [label, id] of [['Changes', 'changes'], ['Tasks', 'tasks'], ['Note', 'note'], ['Review', 'review'], ['Commits', 'commits']]) await select(page, label, id);
});

test('browser Back and Forward step once per view across hub.html, Markdown, HTML siblings, and fragments while syncing owner selection', { timeout: 90000 }, async t => {
  const page = await browser.newPage(); t.after(() => page.close()); await open(page);
  await select(page, 'Tasks', 'tasks'); await select(page, 'Note', 'note');
  await explore(page); await frame(page).getByRole('link', { name: 'Go to section' }).click(); await current(page, 'note', '#section');
  await select(page, 'Review', 'review');
  await go(page, 'back', 'note', '#section'); await targetVisible(page);
  await go(page, 'back', 'note'); await go(page, 'back', 'tasks'); await go(page, 'back', 'commits');
  await go(page, 'forward', 'tasks'); await go(page, 'forward', 'note'); await go(page, 'forward', 'note', '#section'); await go(page, 'forward', 'review');
  await page.evaluate(() => { history.back(); history.back(); }); await current(page, 'note');
});

test('direct ?view=ID#fragment link opens Markdown and published HTML siblings and scrolls to target without scroll-restore clobber', { timeout: 60000 }, async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  for (const id of ['note', 'review']) { await open(page, `?view=${id}#section`); await current(page, id, '#section'); await targetVisible(page); await page.reload(); await current(page, id, '#section'); await targetVisible(page); }
});

test('clicking #fragment links on Markdown and published HTML siblings stays in-page with base href, updates URL, and preserves annotate mode', { timeout: 60000 }, async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  for (const id of ['note', 'review']) {
    await open(page, `?view=${id}`); await current(page, id);
    await explore(page); await frame(page).getByRole('link', { name: 'Go to section' }).click(); await current(page, id, '#section'); await targetVisible(page);
    await go(page, 'back', id);
    if (await page.locator('#annotation').getAttribute('aria-pressed') !== 'true') await page.locator('#annotation').click();
    await frame(page).getByRole('link', { name: 'Go to section' }).click();
    await frame(page).locator('.lavish-annotation-card').waitFor({ timeout: 10000 });
    assert.equal(new URL(page.url()).hash, '');
  }
});

test('Back/Forward across hub.html and HTML sibling prompts when dirty and restores URL on cancel', { timeout: 60000 }, async t => {
  const page = await browser.newPage(); t.after(() => page.close()); await open(page, '?view=tasks'); await current(page, 'tasks');
  await select(page, 'Review', 'review');
  await frame(page).getByRole('textbox', { name: 'Frame draft' }).fill('Unsaved');
  await page.evaluate(() => history.back());
  await frame(page).getByRole('dialog', { name: 'Leave with unsaved edits?' }).getByRole('button', { name: 'Keep editing' }).click({ timeout: 8000 });
  await current(page, 'review');
  assert.equal(await frame(page).getByRole('textbox', { name: 'Frame draft' }).inputValue(), 'Unsaved');
});
