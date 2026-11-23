import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { resolveWorkspace } from '../src/hub-workspace.mjs';
import { createLavishClient } from '../src/lavish-http.mjs';
import { SessionStore } from '../vendor/lavish/src/session-store.js';

const cli = path.resolve('bin/lavish-hub');
const lavishBin = path.resolve('vendor/lavish/dist/cli.mjs');
const execute = promisify(execFile);

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer().once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

async function startLavishServer(t, env, port) {
  const child = spawn(process.execPath, [lavishBin, 'server', '--port', String(port)], { env, stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    try { await fetch(`${base}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) }); } catch {}
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([exited, delay(3000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    for (let i = 0; i < 40; i++) {
      try { await fetch(`${base}/health`, { signal: AbortSignal.timeout(200) }); await delay(50); } catch { break; }
    }
  });
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return base; } catch {}
    await delay(25);
  }
  throw new Error('Real Lavish server did not become ready');
}

function startHubOwner(t, repo, env) {
  const child = spawn(process.execPath, [cli, 'listen', '--workspace', repo], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { child, stdout: '', stderr: '', exited: new Promise(resolve => child.once('exit', resolve)) };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { state.stdout += chunk; });
  child.stderr.on('data', chunk => { state.stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([state.exited, delay(5000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
  return state;
}

async function waitForRuntime(runtimeFile, owner) {
  for (let i = 0; i < 400; i++) {
    try { return JSON.parse(await readFile(runtimeFile, 'utf8')); }
    catch {
      if (owner.child.exitCode !== null) throw new Error(`Hub owner exited early:\n${owner.stderr}`);
      await delay(25);
    }
  }
  throw new Error(`Timed out waiting for ${runtimeFile}:\n${owner.stderr}`);
}

async function waitFor(fn, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('offline feedback queues in Lavish, delivers on hub reconnect, and updates reviewer receipts', { timeout: 60000 }, async t => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hub-recovery-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  const state = path.join(dir, 'lavish');
  const data = path.join(dir, 'data');
  const xdgState = path.join(dir, 'xdg-state');
  await Promise.all([mkdir(repo), mkdir(state), mkdir(data), mkdir(xdgState)]);
  execFileSync('jj', ['git', 'init', repo]);

  const port = await freePort();
  const env = {
    ...process.env,
    LAVISH_AXI_TELEMETRY: '0',
    LAVISH_AXI_PORT: String(port),
    LAVISH_AXI_HOST: '127.0.0.1',
    LAVISH_AXI_NO_OPEN: '1',
    LAVISH_AXI_STATE_DIR: state,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: xdgState,
  };
  delete env.HC_TERMINAL_ID;

  const base = await startLavishServer(t, env, port);
  const identity = await resolveWorkspace(repo, env);
  const runtimeFile = path.join(identity.directory, 'owner', 'runtime.json');

  // Start the hub owner once to open the review session, then stop it so the owner is absent.
  const firstOwner = startHubOwner(t, repo, env);
  const firstRuntime = await waitForRuntime(runtimeFile, firstOwner);
  const page = firstRuntime.page;
  const reviewUrl = (await execute(process.execPath, [cli, 'url', '--workspace', repo], { env, timeout: 5000 })).stdout.trim();
  const sessionKey = new URL(reviewUrl).pathname.split('/').pop();

  await waitFor(async () => {
    const health = await (await fetch(`${base}/health`)).json();
    return health.listeners.some(listener => listener.key === sessionKey);
  }, 'initial hub listener registration');

  await execute(process.execPath, [cli, 'stop', '--workspace', repo], { env, timeout: 5000 });
  assert.equal(await firstOwner.exited, 0, firstOwner.stderr);

  // Disconnecting during a waiting poll releases the listener immediately.
  await waitFor(async () => {
    const health = await (await fetch(`${base}/health`)).json();
    return health.listeners.length === 0;
  }, 'listener release after stop');

  // Open the review in a real browser while no hub owner is listening and submit a comment.
  const browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true });
  t.after(() => browser.close());
  const browserPage = await browser.newPage();
  await browserPage.goto(reviewUrl);
  await browserPage.locator('#chatLog').waitFor();

  const submitRes = await fetch(`${base}/api/${sessionKey}/prompts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ prompts: [{ prompt: 'Comment while owner is offline', tag: 'message' }] }),
  });
  assert.equal(submitRes.status, 200);

  // Reviewer sees their queued comment with Seen unticked and "No agent is listening".
  const bubble = browserPage.locator('#chatLog .bubble.user', { hasText: 'Comment while owner is offline' });
  await bubble.waitFor();
  await waitFor(async () => (await bubble.locator('.receipt-note').textContent()) === 'No agent is listening', 'offline receipt note');
  const seenStep = bubble.locator('.receipt-step').nth(0);
  const doneStep = bubble.locator('.receipt-step').nth(2);
  assert.equal(await seenStep.evaluate(el => el.classList.contains('is-done')), false);
  assert.match(await seenStep.getAttribute('aria-label'), /^Seen: not yet$/);

  const stateWhileOffline = JSON.parse(await readFile(path.join(state, 'state.json'), 'utf8'));
  const offlineEntry = stateWhileOffline.sessions[sessionKey].chat.find(entry => entry.text === 'Comment while owner is offline');
  assert.ok(offlineEntry);
  assert.equal(offlineEntry.delivered_at, undefined);

  // Reconnect the hub owner: it receives the queued comment and the reviewer sees Seen.
  const secondOwner = startHubOwner(t, repo, env);
  await waitForRuntime(runtimeFile, secondOwner);
  const notificationLine = await waitFor(() => {
    const lines = secondOwner.stdout.split('\n').filter(Boolean);
    return lines.find(line => line.includes('Comment while owner is offline'));
  }, 'agent-notification on reconnect');
  const notification = JSON.parse(notificationLine);
  assert.equal(notification.type, 'agent-notification');
  assert.equal(notification.prompts[0].prompt, 'Comment while owner is offline');

  await waitFor(async () => seenStep.evaluate(el => el.classList.contains('is-done')), 'Seen receipt after reconnect');
  assert.equal(await bubble.locator('.receipt-note').count(), 0);
  assert.equal(await doneStep.evaluate(el => el.classList.contains('is-done')), false);

  // Replying stamps Done and shows the reply in the reviewer's chat.
  await execute(process.execPath, [cli, 'reply', page, '--agent-reply', 'Handled after reconnect'], { env, timeout: 10000 });
  await browserPage.locator('#chatLog .bubble.agent', { hasText: 'Handled after reconnect' }).waitFor();
  await waitFor(async () => doneStep.evaluate(el => el.classList.contains('is-done')), 'Done receipt after reply');

  // Stop the owner cleanly and end the session so no private Lavish sessions remain.
  await execute(process.execPath, [cli, 'stop', '--workspace', repo], { env, timeout: 5000 });
  assert.equal(await secondOwner.exited, 0, secondOwner.stderr);
  await createLavishClient({ env }).end(page);
});

test('abrupt post-delivery exit leaves comment Seen in Lavish chat and does not re-deliver on reconnect', { timeout: 45000 }, async t => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hub-post-delivery-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = path.join(dir, 'lavish');
  const file = path.join(dir, 'review.html');
  await mkdir(state);
  await writeFile(file, '<!doctype html><html lang="en"><title>Recovery probe</title><p>Review</p></html>');

  const port = await freePort();
  const env = { ...process.env, LAVISH_AXI_TELEMETRY: '0', LAVISH_AXI_PORT: String(port), LAVISH_AXI_HOST: '127.0.0.1', LAVISH_AXI_NO_OPEN: '1', LAVISH_AXI_STATE_DIR: state };
  const base = await startLavishServer(t, env, port);

  const openRes = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ file }),
  });
  const opened = await openRes.json();
  const client = createLavishClient({ env });
  t.after(async () => { await client.end(file).catch(() => {}); });

  // Disconnect during an active waiting poll releases the listener cleanly.
  const abortController = new AbortController();
  const waitingClient = createLavishClient({ env, signal: abortController.signal });
  const pendingPoll = waitingClient.poll(file, 'disconnecting-owner', { timeoutMs: 10000 });
  await waitFor(async () => {
    const health = await (await fetch(`${base}/health`)).json();
    return health.listeners.some(listener => listener.label === 'disconnecting-owner');
  }, 'disconnecting-owner listener');
  abortController.abort();
  await assert.rejects(pendingPoll, { name: 'AbortError' });
  await waitFor(async () => {
    const health = await (await fetch(`${base}/health`)).json();
    return health.listeners.length === 0;
  }, 'listener cleanup after mid-poll abort');

  // Queue a comment, consume it with one owner, then simulate that owner exiting before replying.
  const submitRes = await fetch(`${base}/api/${opened.key}/prompts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ prompts: [{ prompt: 'Delivered just before crash', tag: 'message' }] }),
  });
  assert.equal(submitRes.status, 200);

  const delivered = await client.poll(file, 'owner-before-crash', { timeoutMs: 0 });
  assert.equal(delivered.session.status, 'feedback');
  assert.equal(delivered.prompts[0].prompt, 'Delivered just before crash');

  // Reconnecting with a fresh owner does NOT re-deliver the already consumed batch.
  const afterReconnect = await client.poll(file, 'owner-after-crash', { timeoutMs: 0 });
  assert.equal(afterReconnect.session.status, 'waiting');

  // Lavish still retains the note in session.chat stamped Seen (not Done), and reply still works.
  const storedBeforeReply = JSON.parse(await readFile(path.join(state, 'state.json'), 'utf8'));
  const chatEntry = storedBeforeReply.sessions[opened.key].chat.find(entry => entry.text === 'Delivered just before crash');
  assert.ok(chatEntry?.delivered_at, 'note stays marked Seen in review chat');
  assert.equal(chatEntry.done_at, undefined);

  assert.equal((await client.reply(file, 'Recovered from review chat')).status, 'sent');
  const storedAfterReply = JSON.parse(await readFile(path.join(state, 'state.json'), 'utf8'));
  const completedEntry = storedAfterReply.sessions[opened.key].chat.find(entry => entry.text === 'Delivered just before crash');
  assert.ok(completedEntry?.done_at, 'reply marks the note Done');
  assert.equal((await client.end(file)).status, 'ended');
});

test('SessionStore restore re-queues a closed-poll batch and removes its Seen stamp', async t => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lavish-restore-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'review.html');
  await writeFile(file, '<!doctype html><p>Restore probe</p>');
  const store = new SessionStore(path.join(dir, 'state.json'));
  const session = await store.upsertSession(file, 'http://127.0.0.1:4388/session/test');

  await store.queuePrompts(session.key, {
    prompts: [{ prompt: 'Must survive mid-take disconnect', tag: 'message' }],
  });
  const taken = await store.takeFeedback(session.key);
  assert.equal(taken.status, 'feedback');
  assert.equal(taken.prompts[0].prompt, 'Must survive mid-take disconnect');

  const stamped = await store.findByKey(session.key);
  assert.ok(stamped.chat[0].delivered_at, 'takeFeedback stamps Seen');

  await store.queuePrompts(
    session.key,
    {
      dom_snapshot: taken.dom_snapshot,
      snapshot_page: taken.snapshot_page,
      snapshot_page_proof: taken.snapshot_page_proof,
      prompts: taken.prompts,
      delivery_seq: taken.delivery_seq,
      receipt_ids: taken.receipt_ids,
    },
    { restore: true },
  );

  const restored = await store.findByKey(session.key);
  assert.equal(restored.chat[0].delivered_at, undefined, 'restore removes the Seen stamp');
  assert.equal(restored.prompts.length, 1);

  const redelivered = await store.takeFeedback(session.key);
  assert.equal(redelivered.status, 'feedback');
  assert.equal(redelivered.prompts[0].prompt, 'Must survive mid-take disconnect');
  const finalSession = await store.findByKey(session.key);
  assert.ok(finalSession.chat[0].delivered_at, 'next poll re-stamps Seen');
});
