import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const require = createRequire(import.meta.url);

async function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
  });
}

export async function isolatedLavish({ tempRoot = os.tmpdir(), portAllocator = allocatePort, exec = execFileSync, shutdownTimeoutMs = 15000 } = {}) {
  const dir = await mkdtemp(path.join(tempRoot, 'lavish-shots-'));
  let port;
  try { port = await portAllocator(); }
  catch (error) {
    try { await rm(dir, { recursive: true, force: true }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Initialization and cleanup failed'); }
    throw error;
  }
  const env = { ...process.env, LAVISH_AXI_STATE_DIR: path.join(dir, 'lavish'), LAVISH_AXI_PORT: String(port), XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_DATA_HOME: path.join(dir, 'data'), XDG_STATE_HOME: path.join(dir, 'state') };
  delete env.HC_TERMINAL_ID;
  const files = new Set(); let serverProcess;
  const command = (name, args, options = {}) => exec(name, args, { encoding: 'utf8', timeout: 30000, ...options });
  const run = args => command('lavish-axi', args, { env });
  const serverCommand = new RegExp(`lavish-axi[^\\n]*server --port ${port}(?:\\s|$)`);
  const owned = pid => {
    // Inspect locally, never log process environments: they may contain secrets.
    const args = command('ps', ['eww', '-p', String(pid), '-o', 'command=']);
    return serverCommand.test(args) && args.split(/\s+/).includes(`LAVISH_AXI_STATE_DIR=${env.LAVISH_AXI_STATE_DIR}`);
  };
  const identifyServer = () => {
    if (serverProcess) return;
    const processes = command('ps', ['-A', '-o', 'pid=,args=']);
    for (const line of processes.split('\n').filter(line => serverCommand.test(line))) {
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (owned(pid)) { serverProcess = { pid }; return; }
    }
  };
  const alive = () => {
    if (!serverProcess) return false;
    try { process.kill(serverProcess.pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  const listening = () => new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
    socket.setTimeout(250, () => finish(true));
  });
  const waitStopped = async timeout => {
    const deadline = Date.now() + timeout;
    do {
      if (!await listening() && !alive()) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    return false;
  };
  return {
    dir, env,
    open(file) {
      files.add(file); // Track even an open that fails after creating the session.
      let output, openError;
      try { output = run([file, '--no-open']); } catch (error) { openError = error; }
      try { identifyServer(); }
      catch (error) { if (!openError) throw error; }
      if (openError) throw openError;
      if (!serverProcess) throw new Error('Cannot identify the isolated Lavish server process');
      const url = output.match(/url:\s*"?(https?:\/\/[^"\s]+)/)?.[1];
      if (!url) throw new Error(`Lavish did not return a URL: ${output}`);
      return url;
    },
    async close() {
      const errors = [], cleanup = { sessionsEnded: 0, workersStarted: 0, serverStopped: false, tempRemoved: false };
      const attempt = async action => { try { await action(); } catch (error) { errors.push(error); } };
      try {
        await attempt(() => identifyServer());
        for (const file of files) await attempt(() => { run(['end', file]); cleanup.sessionsEnded++; });
        await attempt(async () => {
          cleanup.serverStopped = await waitStopped(shutdownTimeoutMs);
          if (!cleanup.serverStopped) {
            throw new Error('Isolated Lavish server did not stop normally; cleanup incomplete');
          }
        });
        if (files.size) await attempt(async () => {
          const state = JSON.parse(await readFile(path.join(env.LAVISH_AXI_STATE_DIR, 'state.json'), 'utf8'));
          if (Object.values(state.sessions).some(session => session.status !== 'ended')) throw new Error('Private state contains a live session');
        });
      } finally {
        await attempt(async () => {
          await rm(dir, { recursive: true, force: true });
          try { await access(dir); }
          catch (error) { if (error.code === 'ENOENT') cleanup.tempRemoved = true; else throw error; }
          if (!cleanup.tempRemoved) throw new Error('Private temporary directory still exists');
        });
      }
      if (errors.length) {
        const error = new AggregateError(errors, `Cleanup failed: ${errors.map(error => error.message).join('; ')}`);
        error.cleanup = cleanup; throw error;
      }
      return cleanup;
    },
  };
}

export async function closeVisualResources(browser, lavish) {
  const errors = []; let cleanup;
  try { await browser?.close(); } catch (error) { errors.push(`Browser cleanup: ${error.message}`); }
  try { cleanup = await lavish?.close(); }
  catch (error) { cleanup = error.cleanup; errors.push(error.message); }
  return { cleanup, errors };
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
