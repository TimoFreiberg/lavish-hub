// Transport-only RSS comparison, including this process, Lavish, and all CLI
// poll children. No herdr, review browser, renderer, or shared relay is started.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createLavishClient } from '../src/lavish-http.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
if (!process.argv[2]) {
  for (const count of [1, 5, 20]) for (const mode of ['cli', 'http']) {
    const child = spawn(process.execPath, [process.argv[1], mode, String(count)], { stdio: ['ignore', 'inherit', 'inherit'] });
    const code = await new Promise(resolve => child.once('exit', resolve));
    if (code) process.exit(code);
  }
} else {
  const [mode, countText] = process.argv.slice(2), count = Number(countText);
  if (!['cli', 'http'].includes(mode) || ![1, 5, 20].includes(count)) throw new Error('Expected cli|http and 1|5|20');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lavish-rss-'));
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
  const env = { ...process.env, LAVISH_AXI_TELEMETRY: '0', LAVISH_AXI_PORT: String(port), LAVISH_AXI_STATE_DIR: path.join(dir, 'state'), LAVISH_AXI_HOST: '127.0.0.1', LAVISH_AXI_NO_OPEN: '1' };
  // Keep all state private, including config that can affect startup behavior.
  for (const name of ['CONFIG', 'DATA', 'STATE']) env[`XDG_${name}_HOME`] = path.join(dir, name.toLowerCase());
  delete env.HC_TERMINAL_ID;
  const binary = await realpath(execFileSync('which', ['lavish-axi'], { encoding: 'utf8' }).trim());
  const children = [];
  const start = args => { const child = spawn(binary, args, { env, stdio: 'ignore' }); const done = new Promise(resolve => child.once('exit', resolve)); children.push({ child, done }); return child; };
  const server = start(['server', '--port', String(port)]), base = `http://127.0.0.1:${port}`;
  const controller = new AbortController(), client = createLavishClient({ env, signal: controller.signal });
  const files = [], pending = [];
  async function health() { const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) }); if (!response.ok) throw new Error('Server not ready'); return response.json(); }
  async function until(check) { for (let i = 0; i < 400; i++) { try { if (await check()) return; } catch {} await pause(25); } throw new Error('Timed out waiting for Lavish'); }
  try {
    await until(async () => (await health()).ok);
    for (let i = 0; i < count; i++) {
      const file = path.join(dir, `page-${i}.html`); files.push(file); await writeFile(file, '<!doctype html><html lang="en"><title>RSS fixture</title><p>Review</p></html>');
      const response = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file }) });
      if (!response.ok) throw new Error(`Open failed: ${response.status}`); await response.json();
      if (mode === 'cli') start(['poll', file, '--owner', `rss-${i}`]);
      else pending.push(client.poll(file, `rss-${i}`).catch(error => { if (!controller.signal.aborted) throw error; }));
    }
    await until(async () => (await health()).listeners.length === count);
    await pause(500);
    const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    const owned = new Set([process.pid]);
    for (let changed = true; changed;) { changed = false; for (const [pid, parent] of rows) if (owned.has(parent) && !owned.has(pid)) { owned.add(pid); changed = true; } }
    // Exclude the already-exited ps measurement child from the totals.
    const active = new Set([process.pid, ...children.map(({ child }) => child.pid)]);
    const rss = rows.filter(([pid]) => owned.has(pid) && active.has(pid));
    console.log(JSON.stringify({ mode, pages: count, processes: rss.length, totalMiB: +(rss.reduce((sum, row) => sum + row[2], 0) / 1024).toFixed(1), serverMiB: +((rows.find(row => row[0] === server.pid)?.[2] || 0) / 1024).toFixed(1) }));
    if (count === 20) {
      for (const file of files.slice(1)) await client.end(file);
      await pause(1000);
      const serverRSS = Number(execFileSync('ps', ['-p', String(server.pid), '-o', 'rss='], { encoding: 'utf8' }).trim());
      console.log(JSON.stringify({ mode, phase: 'after-ending-19', pages: (await client.list()).sessions.length, serverMiB: +(serverRSS / 1024).toFixed(1) }));
      await client.end(files[0]);
    } else for (const file of files) await client.end(file);
  } finally {
    controller.abort(); await Promise.allSettled(pending);
    for (const { child } of children) child.kill('SIGTERM');
    await Promise.all(children.map(({ done }) => done));
    await rm(dir, { recursive: true, force: true });
  }
}
