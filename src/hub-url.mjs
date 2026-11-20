import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, constants, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { canonicalPath } from './hub-workspace.mjs';
import { createLavishClient } from './lavish-http.mjs';
import { runtimeEnv } from './runtime.mjs';
import { resolveLavishPort } from './lavish-port.mjs';

const exec = promisify(execFile);

export function isWildcardHost(host) {
  const value = String(host || '').trim().toLowerCase();
  const unbracketed = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  const family = isIP(unbracketed);
  if (family === 4) return unbracketed === '0.0.0.0';
  if (family !== 6) return false;
  try {
    const normalized = new URL(`http://[${unbracketed}]/`).hostname.slice(1, -1);
    return normalized === '::' || normalized === '::ffff:0:0';
  } catch { return false; }
}

function parseTailscaleStatus(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== 'object' || String(data.BackendState || '') !== 'Running') return null;
  const ips = [...(Array.isArray(data.Self?.TailscaleIPs) ? data.Self.TailscaleIPs : []), ...(Array.isArray(data.TailscaleIPs) ? data.TailscaleIPs : [])];
  const ipv4 = ips.map(ip => typeof ip === 'string' ? ip.trim() : '').find(ip => isIP(ip) === 4);
  if (!ipv4) return null;
  const magicDnsName = String(data.Self?.DNSName || '').trim().replace(/\.$/, '').toLowerCase();
  const labels = magicDnsName.split('.');
  if (magicDnsName.length > 253 || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return { ipv4, magicDnsName };
}

async function resolveExecutable(command, env) {
  const dirs = path.isAbsolute(command) ? [null] : (env.PATH ?? '/usr/bin:/bin').split(path.delimiter);
  for (const dir of dirs) {
    const candidate = dir === null ? command : path.resolve(dir, command);
    try {
      if ((await stat(candidate)).isFile()) { await access(candidate, constants.X_OK); return candidate; }
    } catch {}
  }
  return null;
}

export async function detectTailscale(env = process.env, { run = exec, platform = process.platform } = {}) {
  const candidates = ['tailscale', ...(platform === 'darwin'
    ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/Applications/Tailscale.app/Contents/MacOS/tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']
    : ['/usr/bin/tailscale', '/usr/local/bin/tailscale'])];
  const deadline = Date.now() + 2000;
  for (const command of new Set(candidates)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const resolved = await resolveExecutable(command, env);
      if (!resolved) continue;
      const { stdout } = await run(resolved, ['status', '--json'], { timeout: Math.max(1, remaining), maxBuffer: 2_000_000, encoding: 'utf8' });
      const parsed = parseTailscaleStatus(String(stdout || ''));
      if (parsed) return parsed;
    } catch {}
  }
  return null;
}

export async function computeHubUrl(identity, { env = process.env, detect = detectTailscale, client = createLavishClient } = {}) {
  const port = await resolveLavishPort(env);
  env = { ...runtimeEnv(env), LAVISH_AXI_PORT: String(port) };
  const health = await client({ env }).verifyIfRunning();
  const page = await canonicalPath(path.join(identity.directory, 'hub.html'));
  const key = createHash('sha256').update(page).digest('hex').slice(0, 16);
  const envHost = env.LAVISH_AXI_HOST?.trim() || '';
  const tailscale = !envHost ? await detect(env) : null;
  const phoneReady = Boolean(tailscale?.magicDnsName && (!health || health.hosts?.includes(tailscale.ipv4)));
  const host = phoneReady ? tailscale.magicDnsName : env.LAVISH_AXI_LINK_HOST?.trim() || (!isWildcardHost(envHost) && envHost) || '127.0.0.1';
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${authority}:${port}/session/${key}`;
}
