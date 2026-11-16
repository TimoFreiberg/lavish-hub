import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');

// Resolve aliases even when the final components have not been created yet.
async function canonicalPath(value) {
  const absolute = path.resolve(value);
  try { return await realpath(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await canonicalPath(parent), path.basename(absolute));
  }
}

async function hubDirectory(root, env) {
  const lavishState = await canonicalPath(env.LAVISH_AXI_STATE_DIR || path.join(os.homedir(), '.lavish-axi'));
  const data = await canonicalPath(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
  return path.join(data, 'lavish-kit', 'hubs', digest(`${lavishState}\0${root}`));
}

// Record filesystem identity as well as paths: a new repository at the same
// checkout path must not receive actions intended for its predecessor.
export async function resolveWorkspace(directory = process.cwd(), env = process.env) {
  const { stdout } = await exec('jj', ['root'], { cwd: directory });
  const root = await realpath(stdout.trim());
  const jj = path.join(root, '.jj');
  const repoEntry = path.join(jj, 'repo');
  const entry = await lstat(repoEntry);
  const repo = await realpath(entry.isFile()
    ? path.resolve(jj, (await readFile(repoEntry, 'utf8')).trim()) : repoEntry);
  const [workspaceStat, repoStat] = await Promise.all([stat(jj), stat(repo)]);
  const identity = { root, repo, workspaceDevice: workspaceStat.dev, workspaceInode: workspaceStat.ino, repoDevice: repoStat.dev, repoInode: repoStat.ino };
  return { ...identity, directory: await hubDirectory(root, env) };
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

export async function workspaceMatches(identity) {
  try {
    const current = await resolveWorkspace(identity.root);
    return ['root', 'repo', 'workspaceDevice', 'workspaceInode', 'repoDevice', 'repoInode'].every(key => current[key] === identity[key]);
  } catch { return false; }
}
