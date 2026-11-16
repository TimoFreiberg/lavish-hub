import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');

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
  const lavishState = path.resolve(env.LAVISH_AXI_STATE_DIR || path.join(os.homedir(), '.lavish-axi'));
  const data = path.resolve(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
  return { ...identity, directory: path.join(data, 'lavish-kit', 'hubs', digest(`${lavishState}\0${root}`)) };
}

export async function workspaceMatches(identity) {
  try {
    const current = await resolveWorkspace(identity.root);
    return ['root', 'repo', 'workspaceDevice', 'workspaceInode', 'repoDevice', 'repoInode'].every(key => current[key] === identity[key]);
  } catch { return false; }
}
