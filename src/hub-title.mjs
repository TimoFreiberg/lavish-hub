import { execFile } from 'node:child_process';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { validateSessionId } from './hub-workspace.mjs';

const execFileAsync = promisify(execFile);

export function validateSessionTitle(title) {
  if (typeof title !== 'string' || /[\x00-\x1f\x7f]/.test(title)) throw new Error('Invalid session title');
  const trimmed = title.trim();
  if (!trimmed || trimmed.length > 240) throw new Error('Invalid session title');
  return trimmed;
}

export function parseProcStatPpid(stat) {
  const end = stat.lastIndexOf(')');
  if (end < 0) return null;
  const fields = stat.slice(end + 1).trim().split(/\s+/);
  return /^\d+$/.test(fields[1] || '') ? Number(fields[1]) : null;
}

export function parsePsSnapshot(snapshot) {
  const parents = new Map();
  for (const line of snapshot.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (match) parents.set(Number(match[1]), Number(match[2]));
  }
  return parents;
}

export async function discoverAncestorPids({ ppid }) {
  let snapshot;
  const parentFromPs = async current => {
    if (!snapshot) snapshot = execFileAsync('ps', ['-eo', 'pid=,ppid=']).then(({ stdout }) => parsePsSnapshot(stdout)).catch(() => new Map());
    return (await snapshot).get(current);
  };
  const result = [], seen = new Set();
  let current = ppid;
  while (Number.isSafeInteger(current) && current > 1 && !seen.has(current) && result.length < 64) {
    seen.add(current);
    result.push(current);
    let parent;
    if (process.platform === 'linux') {
      try { parent = parseProcStatPpid(await readFile(`/proc/${current}/stat`, 'utf8')); } catch {}
    }
    if (!Number.isSafeInteger(parent)) parent = await parentFromPs(current);
    current = parent;
  }
  return result;
}

export function createTitleResolver({ providers, validate = validateSessionTitle, env } = {}) {
  providers ||= [createPolytokenTitleProvider({ env })];
  return {
    async resolve(ctx = {}) {
      for (const provider of providers) {
        let value;
        try { value = await provider.resolve(ctx); } catch { continue; }
        if (typeof value !== 'string' || !value.trim()) continue;
        try { return validate(value); } catch { return null; }
      }
      return null;
    },
  };
}

export function createPolytokenTitleProvider({ env = process.env, ppid = process.ppid, getAncestorPids = discoverAncestorPids, sessionsDir } = {}) {
  const root = sessionsDir || path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'polytoken', 'sessions-v1');
  let ancestorsPromise, matchedRecordPath, negativeScanMtime;
  const ancestors = () => ancestorsPromise ||= Promise.resolve().then(() => getAncestorPids({ ppid })).catch(() => []);
  const readRecord = async file => JSON.parse(await readFile(file, 'utf8'));
  const canonical = async value => {
    if (typeof value !== 'string' || !value) return null;
    try { return await realpath(value); } catch { return path.resolve(value); }
  };
  const title = record => {
    try { return validateSessionTitle(record?.session_title); } catch { return null; }
  };
  return {
    name: 'polytoken',
    async resolve(ctx = {}) {
      try {
        if (matchedRecordPath) {
          try { return title(await readRecord(matchedRecordPath)); }
          catch (error) { if (error.code !== 'ENOENT') return null; matchedRecordPath = undefined; }
        }
        for (const candidate of new Set([ctx.session, env.POLYTOKEN_SESSION_ID])) {
          let id;
          try { id = validateSessionId(candidate); } catch { continue; }
          const file = path.join(root, id, 'record.json');
          try {
            const record = await readRecord(file);
            matchedRecordPath = file;
            return title(record);
          } catch {}
        }
        const pids = (await ancestors()).filter(pid => pid > 1);
        const mtime = (await stat(root)).mtimeMs;
        if (negativeScanMtime === mtime) return null;
        const entries = await readdir(root, { withFileTypes: true });
        const roots = (await Promise.all([canonical(ctx.workspaceRoot), canonical(ctx.primaryRoot)])).filter(Boolean);
        const matches = [];
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const file = path.join(root, entry.name, 'record.json');
          try {
            const record = await readRecord(file);
            const distance = Number.isSafeInteger(record.pid) ? pids.indexOf(record.pid) : -1;
            if (distance < 0) continue;
            const project = await canonical(record.project_path);
            matches.push({ file, record, distance, sameProject: project && roots.includes(project), started: Date.parse(record.started_at) || 0 });
          } catch {}
        }
        matches.sort((a, b) => Number(b.sameProject) - Number(a.sameProject) || a.distance - b.distance || b.started - a.started);
        if (!matches.length) { negativeScanMtime = mtime; return null; }
        negativeScanMtime = undefined;
        matchedRecordPath = matches[0].file;
        return title(matches[0].record);
      } catch { return null; }
    },
  };
}
