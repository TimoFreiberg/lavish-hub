import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile, chmod } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveWorkspace } from '../src/hub-workspace.mjs';
import { chromium } from 'playwright-core';

const run = promisify(execFile);
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
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PATH_TRAP: path.join(dir, 'used'), LAVISH_AXI_STATE_DIR: state, LAVISH_AXI_PORT: String(port), XDG_DATA_HOME: path.join(dir, 'data'), XDG_STATE_HOME: path.join(dir, 'xdg') };
  delete env.HC_TERMINAL_ID;
  const identity = await resolveWorkspace(repo, env), runtime = path.join(identity.directory, 'owner', 'runtime.json');
  const child = spawn(process.execPath, [path.resolve('bin/lavish-kit'), 'hub', 'listen', '--workspace', repo], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
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
  await assert.rejects(stat(env.PATH_TRAP), { code: 'ENOENT' });
  const source = path.join(dir, 'review.html');
  await writeFile(source, '<!doctype html><html><head><link rel="stylesheet" href="review.css"></head><body><h1 id="authored">Published review</h1><script src="review.js"></script></body></html>');
  await writeFile(path.join(dir, 'review.css'), '#authored { color: rgb(1, 2, 3) }');
  await writeFile(path.join(dir, 'review.js'), 'document.querySelector("#authored").dataset.ran="yes"');
  await run(process.execPath, [path.resolve('bin/lavish-kit'), 'hub', 'publish', source, '--id', 'review', '--title', 'Review', '--workspace', repo], { env });
  const url = stderr.match(/ready: (https?:\/\/\S+)/)?.[1];
  assert.ok(url, stderr);
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(url);
  const authored = page.frameLocator('#artifact').locator('#authored');
  await authored.waitFor({ timeout: 20000 });
  assert.equal(await authored.getAttribute('data-ran'), 'yes');
  assert.equal(await authored.evaluate(node => getComputedStyle(node).color), 'rgb(1, 2, 3)');
  assert.match(page.frames().find(frame => frame.url().includes('document-'))?.url() || '', /document-.*\.html/);
  await page.frameLocator('#artifact').getByRole('link', { name: 'Workspace hub' }).click();
  await page.frameLocator('#artifact').getByRole('heading', { name: 'Commits', exact: true }).waitFor();
  await run(process.execPath, [path.resolve('bin/lavish-kit'), 'hub', 'stop', '--workspace', repo], { env });
  const exit = child.exitCode === null ? await new Promise(resolve => child.once('exit', resolve)) : child.exitCode;
  assert.equal(exit, 0, stderr);
});
