import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { markedProcesses } from './test-process-audit.mjs';

const mode = process.argv[2];
if (!['test', 'shots'].includes(mode)) throw new Error('Expected test or shots');
const root = await mkdtemp(path.join(os.tmpdir(), 'lavish-kit-run-'));
const port = await new Promise((resolve, reject) => {
  const server = net.createServer().once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
});
const marker = randomUUID();
const env = { ...process.env, LAVISH_KIT_TEST_RUN: marker, TMPDIR: root, LAVISH_AXI_STATE_DIR: path.join(root, 'lavish'), LAVISH_AXI_PORT: String(port), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state') };
delete env.HC_TERMINAL_ID;
const args = mode === 'test' ? ['--test', '--test-concurrency=1', 'test/'] : ['scripts/shots.mjs'];
let status = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { env, stdio: 'inherit' });
  child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
});
try {
  const listing = execFileSync('lavish-axi', [], { env, encoding: 'utf8', timeout: 10000 });
  const { decode } = await import('@toon-format/toon');
  const sessions = decode(listing).sessions;
  if (!Array.isArray(sessions) || sessions.length) { console.error('Test audit: private Lavish sessions remain or listing is invalid:', listing); status = 1; }
  else console.error('Test audit: no private Lavish sessions remain');
} catch (error) { console.error(`Test audit: cannot list private Lavish sessions: ${error.message}`); status = 1; }
try {
  const leaked = markedProcesses(marker);
  if (leaked.length) { console.error(`Test audit: processes with the run marker remain (PIDs): ${leaked.join(', ')}`); status = 1; }
  else console.error('Test audit: no processes with the run marker remain');
} catch (error) { console.error(`Test audit: cannot inspect processes: ${error.message}`); status = 1; }
if (status === 0) await rm(root, { recursive: true, force: true });
else console.error(`Test audit: retained ${root} for inspection`);
process.exitCode = status;
