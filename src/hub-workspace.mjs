import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { runtimeEnv } from './runtime.mjs';

const exec = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');

// Resolve aliases even when the final components have not been created yet.
export async function canonicalPath(value) {
  const absolute = path.resolve(value);
  try { return await realpath(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await canonicalPath(parent), path.basename(absolute));
  }
}

async function hubDirectory(key, env) {
  const lavishState = await canonicalPath(runtimeEnv(env).LAVISH_AXI_STATE_DIR);
  const data = await canonicalPath(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
  return path.join(data, 'lavish-hub', 'hubs', digest(`${lavishState}\0${key}`));
}

export function validateSessionId(session) {
  if (typeof session !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(session)) throw new Error('Invalid session ID');
  return session;
}

export function resolveSessionId(options = {}, env = process.env) {
  if (options.session !== undefined) return validateSessionId(options.session);
  return env.LAVISH_HUB_SESSION ? validateSessionId(env.LAVISH_HUB_SESSION) : null;
}

export function primaryRootForRepo(repo) {
  if (typeof repo !== 'string' || path.basename(repo) !== 'repo' || path.basename(path.dirname(repo)) !== '.jj') throw new Error('Invalid jj repository path');
  return path.dirname(path.dirname(repo));
}

// Record filesystem identity as well as paths: a new repository at the same
// checkout path must not receive actions intended for its predecessor. The guard
// re-reads these facts from the known root, so it proves the same two directories
// are still linked without paying for a jj process spawn, and it keeps working in
// the recorded-identity mode used when jj is unavailable, where spawning jj would
// have disabled repository actions. A path that is no longer a workspace, or
// metadata laid out differently, fails closed.
async function identityAt(root) {
  const jj = path.join(root, '.jj');
  const repoEntry = path.join(jj, 'repo');
  const entry = await lstat(repoEntry);
  const repo = await realpath(entry.isFile()
    ? path.resolve(jj, (await readFile(repoEntry, 'utf8')).trim()) : repoEntry);
  const [workspaceStat, repoStat] = await Promise.all([stat(jj), stat(repo)]);
  return { root, repo, workspaceDevice: workspaceStat.dev, workspaceInode: workspaceStat.ino, repoDevice: repoStat.dev, repoInode: repoStat.ino };
}

export async function resolveWorkspace(directory = process.cwd(), env = process.env) {
  const { stdout } = await exec('jj', ['root'], { cwd: directory });
  const root = await realpath(stdout.trim());
  const identity = await identityAt(root);
  return { ...identity, directory: await hubDirectory(root, env) };
}

export async function resolveHubSession(directory = process.cwd(), session, env = process.env) {
  validateSessionId(session);
  const { stdout } = await exec('jj', ['root'], { cwd: directory });
  const invocationRoot = await realpath(stdout.trim());
  const identity = await identityAt(invocationRoot);
  const root = primaryRootForRepo(identity.repo);
  const primary = await identityAt(root);
  if (!['repo', 'repoDevice', 'repoInode'].every(key => primary[key] === identity[key])) throw new Error('Primary workspace does not match repository');
  return { root, repo: identity.repo, repoDevice: identity.repoDevice, repoInode: identity.repoInode, session, directory: await hubDirectory(`repo\0${identity.repo}\0session\0${session}`, env) };
}

export async function resolveRecordedSession(directory, session, env = process.env) {
  validateSessionId(session);
  let repo;
  try { repo = (await identityAt(await realpath(directory))).repo; }
  catch { repo = path.join(await canonicalPath(directory), '.jj', 'repo'); }
  const hub = await hubDirectory(`repo\0${repo}\0session\0${session}`, env);
  const identity = JSON.parse(await readFile(path.join(hub, 'workspace.json'), 'utf8'));
  if (identity.repo !== repo || identity.session !== session || identity.directory !== hub) throw new Error('Recorded session identity does not match');
  return identity;
}

// Only an explicitly named root with previously recorded identity can be used
// when jj is unavailable there; never infer a replacement checkout.
export async function resolveRecordedWorkspace(directory, env = process.env) {
  const root = await canonicalPath(directory);
  const hub = await hubDirectory(root, env);
  const identity = JSON.parse(await readFile(path.join(hub, 'workspace.json'), 'utf8'));
  if (identity.root !== root || identity.directory !== hub) throw new Error('Recorded workspace identity does not match');
  return identity;
}

export async function recordWorkspace(identity) {
  await mkdir(identity.directory, { recursive: true, mode: 0o700 });
  const target = path.join(identity.directory, 'workspace.json');
  const temporary = `${target}.${randomBytes(16).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}

export async function checkoutMatchesRepo(directory, identity) {
  try {
    let root = await realpath(directory);
    while (true) {
      try {
        await lstat(path.join(root, '.jj'));
      } catch (error) {
        if (error.code !== 'ENOENT') return false;
        const parent = path.dirname(root);
        if (parent === root) return false;
        root = parent;
        continue;
      }
      const current = await identityAt(root);
      return ['repo', 'repoDevice', 'repoInode'].every(key => current[key] === identity[key]);
    }
  } catch { return false; }
}

export async function repoMatches(identity) {
  try {
    const root = primaryRootForRepo(identity.repo);
    if (await realpath(root) !== root || (identity.session && identity.root !== root)) return false;
    const current = await identityAt(root);
    return ['repo', 'repoDevice', 'repoInode'].every(key => current[key] === identity[key]);
  } catch { return false; }
}

export async function workspaceMatches(identity) {
  if (identity.session) return repoMatches(identity);
  try {
    const current = await identityAt(await realpath(identity.root));
    return ['root', 'repo', 'workspaceDevice', 'workspaceInode', 'repoDevice', 'repoInode'].every(key => current[key] === identity[key]);
  } catch { return false; }
}
