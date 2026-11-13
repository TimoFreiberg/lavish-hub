import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const require = createRequire(import.meta.url);

export async function isolatedLavish() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lavish-shots-'));
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
  const env = { ...process.env, LAVISH_AXI_STATE_DIR: path.join(dir, 'lavish'), LAVISH_AXI_PORT: String(port), XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_DATA_HOME: path.join(dir, 'data'), XDG_STATE_HOME: path.join(dir, 'state') };
  delete env.HC_TERMINAL_ID;
  const files = new Set(); let serverPid;
  const run = args => execFileSync('lavish-axi', args, { env, encoding: 'utf8', timeout: 30000 });
  return {
    dir, env,
    open(file) {
      files.add(file); // Track even an open that fails after creating the session.
      const output = run([file, '--no-open']);
      if (!serverPid) {
        const processes = execFileSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8' });
        const line = processes.split('\n').find(line => line.includes('lavish-axi') && new RegExp(`server --port ${port}(?:\\s|$)`).test(line));
        if (!line) throw new Error('Cannot identify the isolated Lavish server process');
        serverPid = Number(line.trim().split(/\s+/)[0]);
      }
      const url = output.match(/url:\s*"?(https?:\/\/[^"\s]+)/)?.[1];
      if (!url) throw new Error(`Lavish did not return a URL: ${output}`);
      return url;
    },
    async close() {
      const errors = [];
      for (const file of files) { try { run(['end', file]); } catch (error) { errors.push(error.message); } }
      // Lavish shuts down after its last live session ends. Do not delete its
      // state directory until its HTTP listener is gone.
      const deadline = Date.now() + 15000;
      let listening = true;
      while (listening && Date.now() < deadline) {
        listening = await new Promise(resolve => {
          const socket = net.connect(port, '127.0.0.1');
          socket.once('connect', () => { socket.destroy(); resolve(true); });
          socket.once('error', () => resolve(false));
        });
        if (listening) await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (listening) errors.push('Isolated Lavish server did not stop');
      if (serverPid) {
        let alive = true;
        while (alive && Date.now() < deadline) {
          try { process.kill(serverPid, 0); await new Promise(resolve => setTimeout(resolve, 50)); }
          catch (e) { if (e.code === 'ESRCH') alive = false; else throw e; }
        }
        if (alive) errors.push('Isolated Lavish server process is still alive');
      }
      if (files.size) {
        const state = JSON.parse(await readFile(path.join(env.LAVISH_AXI_STATE_DIR, 'state.json'), 'utf8'));
        if (Object.values(state.sessions).some(session => session.status !== 'ended')) errors.push('Private state contains a live session');
      }
      if (errors.length) throw new Error(`Cleanup failed: ${errors.join('; ')}`);
      await rm(dir, { recursive: true, force: true });
      let tempRemoved = false; try { await access(dir); } catch (e) { if (e.code === 'ENOENT') tempRemoved = true; else throw e; }
      return { sessionsEnded: files.size, workersStarted: 0, serverStopped: !listening, tempRemoved };
    },
  };
}

export async function launchBrowser() {
  return chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
}

export async function offlineRoutes(page) {
  const assets = new Map([
    ['https://cdn.jsdelivr.net/npm/daisyui@5.5.19/daisyui.css', [require.resolve('daisyui/daisyui.css'), 'text/css']],
    ['https://cdn.jsdelivr.net/npm/daisyui@5.5.19/themes.css', [require.resolve('daisyui/themes.css'), 'text/css']],
    ['https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.2.4/dist/index.global.js', [require.resolve('@tailwindcss/browser'), 'text/javascript']],
  ]);
  await page.route('**/*', route => {
    const url = route.request().url(), asset = assets.get(url);
    if (asset) return route.fulfill({ path: asset[0], contentType: asset[1] });
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname) ? route.continue() : route.abort('blockedbyclient');
  });
}

export async function readLayoutIssues(page) {
  // Wait for the actual POST response, not merely a message or a hidden gate.
  // These contracts are from Lavish 0.1.96 dist/cli.mjs:5902,6683-6718,
  // 11046-11075 and dist/chrome-client.js:2521-2536.
  const response = page.waitForResponse(async response => {
    if (!response.url().endsWith('/layout-diagnostics') || response.request().method() !== 'POST') return false;
    const pass = response.request().postDataJSON();
    return pass.complete === true && pass.target_presence_complete === true && response.ok() && (await response.json()).status === 'recorded';
  }, { timeout: 30000 });
  // Lavish's sandboxed artifact has an opaque origin. Match its own
  // postToFrame implementation (dist/chrome-client.js:1772-1774).
  await page.evaluate(() => document.querySelector('#artifact').contentWindow.postMessage({ type: 'lavish:requestLayoutDiagnostics' }, '*'));
  const recorded = await response;
  const endpoint = recorded.url().replace(/layout-diagnostics$/, 'layout-warnings');
  const result = await page.request.get(endpoint);
  if (!result.ok()) throw new Error(`Cannot read Lavish layout inbox: HTTP ${result.status()}`);
  const data = await result.json();
  if (!Array.isArray(data.warnings)) throw new Error('Lavish layout inbox has no warnings array');
  await page.locator('body.layout-gate-active').waitFor({ state: 'detached', timeout: 30000 });
  // Drop session-dependent fingerprints, timestamps and revision history.
  return data.warnings.filter(w => w.active).map(w => ({
    rule: w.rule, selector: w.selector, component: w.component, axis: w.axis,
    overflow_px: w.overflow_px, viewport_class: w.viewport_class,
    viewport_width: w.viewport_width, status: w.status,
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
