import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { markedProcesses } from './test-process-audit.mjs';
import { runSupervised } from './test-supervision.mjs';

const mode = process.argv[2];
if (!['test', 'test-worker', 'shots', 'e2e'].includes(mode)) throw new Error('Expected test, shots, or e2e');
if (mode === 'test') {
  const count = Number(process.env.LAVISH_HUB_TEST_JOBS || 3);
  if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error('LAVISH_HUB_TEST_JOBS must be an integer from 1 to 8');
  const files = (await readdir('test')).filter(name => name.endsWith('.test.mjs')).sort();
  // Approximate baseline seconds, used only to balance groups, never to skip tests.
  const weights = { 'maintenance-finalization': 3, 'maintenance-integration': 14, markdown: 19, 'visual-checks': 17 };
  const groups = Array.from({ length: Math.min(count, files.length) }, () => ({ files: [], weight: 0 }));
  for (const file of files.sort((a, b) => (weights[b.replace('.test.mjs', '')] || 1) - (weights[a.replace('.test.mjs', '')] || 1))) {
    const group = groups.reduce((a, b) => a.weight <= b.weight ? a : b);
    group.files.push(`test/${file}`); group.weight += weights[file.replace('.test.mjs', '')] || 1;
  }
  const children = new Set();
  let cancelled = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cancelled = true; for (const child of children) child.kill(signal); });
  const statuses = await Promise.all(groups.map(group => new Promise(resolve => {
    const child = spawn(process.execPath, [import.meta.filename, 'test-worker', ...group.files], { stdio: 'inherit' });
    children.add(child);
    child.once('error', error => { children.delete(child); console.error(error); resolve(1); });
    child.once('exit', code => { children.delete(child); resolve(code ?? 1); });
  })));
  process.exit(cancelled || statuses.some(code => code !== 0) ? 1 : 0);
}
const controller = new AbortController();
if (mode === 'test-worker') {
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => controller.abort());
}
const root = await mkdtemp(path.join(os.tmpdir(), 'lavish-hub-run-'));
const port = await new Promise((resolve, reject) => {
  const server = net.createServer().once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
});
const runId = randomUUID();
const marker = [process.env.LAVISH_HUB_TEST_RUN, runId].filter(Boolean).join(',');
const env = { ...process.env, LAVISH_AXI_TELEMETRY: '0', LAVISH_HUB_TEST_RUN: marker, TMPDIR: root, LAVISH_AXI_STATE_DIR: path.join(root, 'lavish'), LAVISH_AXI_PORT: String(port), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state') };
delete env.HC_TERMINAL_ID;
// Use a short directory to keep socket paths within macOS Unix socket limits.
let hcRoot;
if (mode === 'e2e') {
  hcRoot = await mkdtemp('/tmp/lk-hc-');
  env.HC_SESSION = `lk-${runId.slice(0, 8)}`;
  env.HC_SOCKET = path.join(hcRoot, 'core.sock');
}
let status = 0;
if (mode === 'test-worker') {
  for (const file of process.argv.slice(3)) {
    if (controller.signal.aborted) { status = 1; break; }
    const result = await runSupervised(['--test', '--test-concurrency=1', file], { env, timeout: 10 * 60 * 1000, signal: controller.signal });
    if (result.timedOut) console.error(`Test runner: ${file} timed out after 10 minutes`);
    if (result.error) console.error(`Test runner: ${file}: ${result.error.message}`);
    if (result.code !== 0) status = 1;
  }
  if (controller.signal.aborted) status = 1;
} else {
  const args = [mode === 'e2e' ? 'test/hub-e2e.mjs' : 'scripts/shots.mjs'];
  status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: 'inherit' });
    const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); resolve(code ?? (signal ? 1 : 0)); });
  });
}
if (hcRoot) {
  try { execFileSync('hc', ['server', 'stop'], { env, encoding: 'utf8', timeout: 15000 }); }
  catch (error) { console.error(`Test audit: cannot stop private hc service: ${error.message}`); status = 1; }
}
try {
  const listing = execFileSync(process.execPath, [path.resolve('vendor/lavish/dist/cli.mjs')], { env, encoding: 'utf8', timeout: 10000 });
  const { decode } = await import('@toon-format/toon');
  const sessions = decode(listing).sessions;
  if (!Array.isArray(sessions) || sessions.length) { console.error('Test audit: private Lavish sessions remain or listing is invalid:', listing); status = 1; }
  else console.error('Test audit: no private Lavish sessions remain');
} catch (error) { console.error(`Test audit: cannot list private Lavish sessions: ${error.message}`); status = 1; }
try {
  let leaked = markedProcesses(marker);
  const deadline = Date.now() + 5000;
  // Detached workers can still be completing normal shutdown after tests exit.
  while (leaked.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    leaked = markedProcesses(marker);
  }
  if (leaked.length) { console.error(`Test audit: processes with the run marker remain (PIDs): ${leaked.join(', ')}`); status = 1; }
  else console.error('Test audit: no processes with the run marker remain');
} catch (error) { console.error(`Test audit: cannot inspect processes: ${error.message}`); status = 1; }
if (controller.signal.aborted) status = 1;
if (status === 0) {
  await rm(root, { recursive: true, force: true });
  if (hcRoot) await rm(hcRoot, { recursive: true, force: true });
} else console.error(`Test audit: retained ${root}${hcRoot ? ` and ${hcRoot}` : ''} for inspection`);
process.exitCode = status;
