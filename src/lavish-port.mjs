import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { canonicalPath } from './hub-workspace.mjs';
import { runtimeEnv } from './runtime.mjs';

const firstPort = 4388;
const lastPort = 4407;
const recordPath = env => path.join(runtimeEnv(env).LAVISH_AXI_STATE_DIR, 'port.json');

export async function withLavishStartupLock(env, action) {
  const directory = runtimeEnv(env).LAVISH_AXI_STATE_DIR;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, 'port-start.lock');
  const deadline = Date.now() + 30000;
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for Lavish startup lock ${lock}`);
      await delay(50);
    }
  }
  try {
    await writeFile(path.join(lock, 'pid'), String(process.pid), { mode: 0o600 });
    return await action();
  } finally { await rm(lock, { recursive: true, force: true }); }
}

export async function recordLavishPort(env, port) {
  const file = recordPath(env);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ port }), { mode: 0o600 });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}

async function available(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', error => error.code === 'EADDRINUSE' || error.code === 'EACCES' ? resolve(false) : reject(error));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export async function resolveLavishPort(input = process.env, { isAvailable = available, request = fetch, locked = false, ports: candidates } = {}) {
  if (!locked && isAvailable === available && request === fetch) return withLavishStartupLock(input, () => resolveLavishPort(input, { isAvailable, request, locked: true, ports: candidates }));
  const env = runtimeEnv(input);
  const explicit = input.LAVISH_AXI_PORT ? Number(input.LAVISH_AXI_PORT) : null;
  if (explicit !== null && (!Number.isInteger(explicit) || explicit < 1 || explicit > 65535)) throw new Error('Invalid LAVISH_AXI_PORT');
  let recorded;
  try {
    recorded = JSON.parse(await readFile(recordPath(input), 'utf8')).port;
    if (!Number.isInteger(recorded) || recorded < 1 || recorded > 65535) throw new Error('Invalid Lavish port record');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const directory = await canonicalPath(path.resolve(env.LAVISH_AXI_STATE_DIR));
  const stateId = createHash('sha256').update(path.join(directory, 'state.json')).digest('hex').slice(0, 16);
  const defaults = candidates ?? Array.from({ length: lastPort - firstPort + 1 }, (_, i) => firstPort + i);
  const ports = [...new Set([...(recorded ? [recorded] : []), ...defaults, ...(explicit ? [explicit] : [])])];
  let free, matching;
  for (const port of ports) {
    if (await isAvailable(port)) { if (defaults.includes(port)) free ??= port; continue; }
    let health;
    try {
      const response = await request(`http://127.0.0.1:${port}/health`, { redirect: 'error', signal: AbortSignal.timeout(500) });
      health = await response.json();
    } catch {
      if (port === recorded) throw new Error(`Cannot identify listener on recorded port ${port}; refusing to start another Lavish server`);
      continue;
    }
    if (!health || typeof health.app !== 'string' || !health.app || (health.app === 'lavish-axi' && !/^[a-f0-9]{16}$/.test(health.state_id || ''))) {
      if (port === recorded) throw new Error(`Cannot identify listener on recorded port ${port}; refusing to start another Lavish server`);
      continue;
    }
    if (health.app === 'lavish-axi' && health.state_id === stateId) {
      if (matching && matching !== port) throw new Error('Multiple Lavish servers use the same state directory');
      matching = port;
    }
  }
  if (matching) {
    if (explicit && explicit !== matching) throw new Error(`Lavish already uses this state directory on port ${matching}; requested port ${explicit}`);
    return matching;
  }
  if (explicit) return explicit;
  if (free !== undefined) return free;
  throw new Error(`No available Lavish port in ${firstPort}–${lastPort}; set LAVISH_AXI_PORT to choose one`);
}
