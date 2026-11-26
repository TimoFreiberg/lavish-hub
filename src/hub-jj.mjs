import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { modelPatch } from './diff/model.mjs';

const MAX_FILE_BYTES = 1024 * 1024;

const exec = promisify(execFile);

async function readFileAt(cwd, op, revision, file) {
  let bytes;
  try {
    ({ stdout: bytes } = await exec('jj', ['--no-pager', '--color=never', '--at-operation', op, 'file', 'show', '-r', revision, '--', `root:${file}`], { cwd, encoding: 'buffer', maxBuffer: MAX_FILE_BYTES }));
  } catch { throw new Error('File content is unavailable or too large'); }
  try {
    if (bytes.includes(0)) throw new Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { throw new Error('File content is not supported text'); }
}

const fields = ['change_id', 'commit_id', 'description', 'immutable', 'divergent', 'current_working_copy'];
const template = `"[" ++ ${fields.map(field => `json(${field})`).join(' ++ "," ++ ')} ++ "]\\n"`;

function run(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('jj', ['--no-pager', '--color=never', ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.on('close', code => code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(`jj ${args.find(arg => !arg.startsWith('-')) || args[0]} failed: ${Buffer.concat(err).toString('utf8').trim() || `exit ${code}`}`)));
    child.stdin.end(input);
  });
}

function parseRows(text) {
  return text.split('\n').filter(Boolean).map(line => {
    const [changeId, commitId, description, immutable, divergent, currentWorkingCopy] = JSON.parse(line);
    return { changeId, commitId, description, immutable, divergent, isWorkingCopy: Boolean(currentWorkingCopy) };
  });
}

async function operation(cwd, { ignoreWorkingCopy = false } = {}) {
  // A normal command snapshots the working copy before we capture the operation.
  if (!ignoreWorkingCopy) await run(cwd, ['status']);
  const id = (await run(cwd, [...(ignoreWorkingCopy ? ['--ignore-working-copy'] : []), 'op', 'log', '-n', '1', '--no-graph', '-T', 'id ++ "\\n"'])).trim();
  if (!/^[0-9a-f]{128}$/.test(id)) throw new Error('Could not determine the current jj operation');
  return id;
}

async function rows(cwd, op, revset) {
  return parseRows(await run(cwd, ['--at-operation', op, 'log', `-r=${revset}`, '--no-graph', '-T', template]));
}

export function escapeJjString(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function isWorkingCopyRev(input) {
  let quoted = false, escaped = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted && escaped) { escaped = false; continue; }
    if (quoted && char === '\\') { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && char === '@' && !/[a-zA-Z0-9_]/.test(input[i + 1] || '')) return true;
  }
  return false;
}

export async function resolveTargetRev(cwd, input, { ignoreWorkingCopy = false } = {}) {
  if (typeof input !== 'string' || !input.trim() || /[\x00-\x1f\x7f]/.test(input)) throw new Error('Invalid revision');
  const log = async revset => parseRows(await run(cwd, [...(ignoreWorkingCopy ? ['--ignore-working-copy'] : []), 'log', `-r=${revset}`, '--no-graph', '-T', template]));
  const single = items => {
    if (!items.length) throw new Error('Revision not found');
    if (items.length !== 1) throw new Error('Revision must resolve to a single commit');
    return items[0];
  };
  const pin = row => ({ input: row.changeId.slice(0, 12), revset: `change_id(${row.changeId})`, kind: 'change', changeId: row.changeId });
  if (isWorkingCopyRev(input)) {
    if (ignoreWorkingCopy) throw new Error('Working-copy revisions require a live workspace checkout');
    return pin(single(await log(input)));
  }
  const escaped = escapeJjString(input), bookmark = `bookmarks(exact:"${escaped}")`;
  const local = await log(bookmark);
  if (local.length > 1) throw new Error('Bookmark is conflicted and resolves to multiple commits');
  if (local.length === 1) return { input, revset: bookmark, kind: 'bookmark' };
  if (input.includes('@')) {
    const at = input.lastIndexOf('@');
    const remote = `remote_bookmarks(exact:"${escapeJjString(input.slice(0, at))}", exact:"${escapeJjString(input.slice(at + 1))}")`;
    const matches = await log(remote);
    if (matches.length > 1) throw new Error('Remote bookmark is conflicted and resolves to multiple commits');
    if (matches.length === 1) return { input, revset: remote, kind: 'remote-bookmark' };
  }
  const row = single(await log(input));
  if (/^[a-z]{1,32}$/i.test(input) && row.changeId.startsWith(input.toLowerCase())) return { input: input.length === 32 ? row.changeId.slice(0, 12) : input, revset: `change_id(${row.changeId})`, kind: 'change', changeId: row.changeId };
  return { input, revset: input, kind: 'revset' };
}

export async function readHubSnapshot(cwd, { target, afterMetadata } = {}) {
  return readSnapshotAt(cwd, await operation(cwd, { ignoreWorkingCopy: Boolean(target?.rev) }), { target, afterMetadata });
}

async function readScopeAt(cwd, op, target) {
  const headRevset = target?.rev?.revset || '@';
  const baseExpr = target?.base?.revset || 'trunk()';
  const baseRows = await rows(cwd, op, `fork_point((${baseExpr}) | (${headRevset}))`);
  const headRows = await rows(cwd, op, headRevset);
  if (baseRows.length !== 1 || headRows.length !== 1) throw new Error('The jj base and working-copy head must each resolve to one commit');
  return { base: baseRows[0].commitId, head: headRows[0].commitId };
}

async function readSnapshotAt(cwd, op, { target, afterMetadata } = {}) {
  const { base, head } = await readScopeAt(cwd, op, target);
  const commits = await rows(cwd, op, `${base}..${head}`);
  if (afterMetadata) await afterMetadata();
  const patch = await run(cwd, ['--at-operation', op, '--config', 'diff.git.show-path-prefix=true', 'diff', '--from', base, '--to', head, '--git']);
  const headDisplay = target?.rev?.input || '@';
  const baseDisplay = target?.base?.input ? `fork_point((${target.base.input}) | (${headDisplay}))` : `fork_point(trunk() | ${headDisplay})`;
  return { operationId: op, base, head, baseDisplay, headDisplay, commits, patch, generated: new Date().toISOString() };
}

export function createHubJj(cwd, { validate = async () => true, beforeDescribe, target } = {}) {
  const resolveCwd = () => typeof cwd === 'function' ? cwd() : cwd;
  let currentTarget = target;
  let pending = Promise.resolve(), cached, expires = 0, flight, generation = 0;
  let stackCached, stackExpires = 0, stackFlight;
  const snapshots = new Map(), rangeSnapshots = new Map();
  async function checkWorkspace() {
    if (!await validate()) throw new Error('Workspace no longer matches its recorded repository');
  }
  async function versions(activeCwd, changeId, ignoreWorkingCopy) {
    const op = await operation(activeCwd, { ignoreWorkingCopy });
    return rows(activeCwd, op, `change_id(${changeId})`).then(items => items.filter(item => item.changeId === changeId));
  }
  async function describe(request) {
    const activeCwd = resolveCwd(), ignoreWorkingCopy = Boolean(currentTarget?.rev);
    const { changeId, commitId, expectedDescription, description } = request;
    if (!/^[a-z]{32}$/.test(changeId || '') || !/^[0-9a-f]{40,128}$/.test(commitId || '') || typeof expectedDescription !== 'string' || typeof description !== 'string' || description.includes('\0')) throw new Error('Invalid description request');
    await checkWorkspace();
    const current = await versions(activeCwd, changeId, ignoreWorkingCopy);
    if (current.length !== 1 || current[0].divergent) return { status: 'conflict', reason: current.length ? 'divergent' : 'missing', current };
    if (current[0].immutable) return { status: 'conflict', reason: 'immutable', current };
    if (current[0].commitId !== commitId || current[0].description !== expectedDescription) return { status: 'conflict', reason: 'stale', current };
    if (beforeDescribe) await beforeDescribe();
    await checkWorkspace();
    await run(activeCwd, [...(ignoreWorkingCopy ? ['--ignore-working-copy'] : []), 'describe', '-r', commitId, '--stdin'], description);
    const updated = await versions(activeCwd, changeId, ignoreWorkingCopy);
    // jj normalizes a nonempty description to end in a newline.
    const intended = description && !description.endsWith('\n') ? `${description}\n` : description;
    if (updated.length !== 1 || updated[0].divergent || updated[0].description !== intended) return { status: 'conflict', reason: 'unexpected-result', current: updated };
    return { status: 'saved', current: updated[0] };
  }
  return {
    setTarget(nextTarget) {
      currentTarget = nextTarget;
      generation++; cached = undefined; stackCached = undefined; snapshots.clear(); rangeSnapshots.clear();
    },
    async scope() {
      await checkWorkspace();
      const activeCwd = resolveCwd(), target = currentTarget;
      const op = await operation(activeCwd, { ignoreWorkingCopy: Boolean(target?.rev) });
      const { base, head } = await readScopeAt(activeCwd, op, target);
      return { baseCommit: base, headCommit: head };
    },
    async summary() {
      await checkWorkspace();
      const activeCwd = resolveCwd(), rev = currentTarget?.rev;
      const log = async revset => parseRows(await run(activeCwd, [...(rev ? ['--ignore-working-copy'] : []), 'log', `-r=${revset}`, '--no-graph', '-T', template]));
      let result = await log(rev?.revset || '@-');
      if (result.length !== 1) throw new Error('Working-copy parent unavailable');
      let description = result[0].description.split('\n')[0].slice(0, 240);
      if (!description && rev) {
        result = await log(`(${rev.revset})-`);
        if (result.length === 1) description = result[0].description.split('\n')[0].slice(0, 240);
      }
      return description || '(no description)';
    },
    async stackCommits() {
      await checkWorkspace();
      while (true) {
        if (stackFlight) { await stackFlight; continue; }
        if (cached && Date.now() < expires) return new Set([cached.head, ...cached.commits.map(commit => commit.commitId)]);
        if (stackCached && Date.now() < stackExpires) return stackCached.commits;
        const started = generation, snapshotTarget = currentTarget, activeCwd = resolveCwd();
        const refresh = (async () => {
          const op = await operation(activeCwd, { ignoreWorkingCopy: true });
          if (generation !== started) return;
          if (stackCached?.operationId === op) { stackExpires = Date.now() + 2000; return; }
          const { base, head } = await readScopeAt(activeCwd, op, snapshotTarget);
          const output = await run(activeCwd, ['--at-operation', op, 'log', '-r', `${base}..${head}`, '--no-graph', '-T', 'json(commit_id) ++ "\\n"']);
          if (generation === started) {
            stackCached = { operationId: op, commits: new Set([head, ...output.split('\n').filter(Boolean).map(line => JSON.parse(line))]) };
            stackExpires = Date.now() + 2000;
          }
        })();
        stackFlight = refresh;
        try { await refresh; } finally { if (stackFlight === refresh) stackFlight = undefined; }
      }
    },
    async snapshot({ force = false, knownVersion } = {}) {
      await checkWorkspace();
      if (force) knownVersion = undefined;
      while (true) {
        if (flight) { await flight; continue; }
        if (!force && cached && Date.now() < expires) return knownVersion === cached.version ? { unchanged: true } : cached;
        const started = generation, snapshotTarget = currentTarget, activeCwd = resolveCwd();
        const refresh = (async () => {
          const op = await operation(activeCwd, { ignoreWorkingCopy: Boolean(snapshotTarget?.rev) });
          if (generation !== started) return;
          if (!force && cached?.operationId === op) {
            expires = Date.now() + 2000;
            return;
          }
          const value = { ...await readSnapshotAt(activeCwd, op, { target: snapshotTarget }), version: randomUUID() };
          if (generation === started) {
            cached = value; expires = Date.now() + 2000;
            snapshots.delete(value.operationId);
            snapshots.set(value.operationId, { version: value.version, base: value.base, head: value.head, files: modelPatch(value.patch).map(({ oldPath, newPath, parseError, status, oldMode, newMode }) => ({ oldPath, newPath, parseError, status, oldMode, newMode })) });
            while (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value);
          }
        })();
        flight = refresh;
        try { await refresh; } finally { if (flight === refresh) flight = undefined; }
        force = false;
      }
    },
    async diffRange({ operationId, from, to, rev }) {
      const commitId = value => typeof value === 'string' && /^[0-9a-f]{40,128}$/.test(value);
      const single = commitId(rev) && from === undefined && to === undefined;
      const range = rev === undefined && commitId(from) && commitId(to);
      if (typeof operationId !== 'string' || !/^[0-9a-f]{128}$/.test(operationId) || (!single && !range)) throw new Error('Invalid diff range request');
      await checkWorkspace();
      const activeCwd = resolveCwd(), started = generation;
      const rangeKey = single ? `rev:${rev}` : `range:${from}:${to}`, key = `${operationId}\0${rangeKey}`;
      const useCached = () => {
        const value = rangeSnapshots.get(key);
        if (!value) return null;
        rangeSnapshots.delete(key); rangeSnapshots.set(key, value);
        return { patch: value.patch, version: value.version, rangeKey };
      };
      const cachedRange = useCached();
      if (cachedRange) return cachedRange;
      const patch = await run(activeCwd, ['--at-operation', operationId, '--config', 'diff.git.show-path-prefix=true', 'diff', ...(single ? ['-r', rev] : ['--from', from, '--to', to]), '--git']);
      if (generation !== started) throw new Error('Diff range is unavailable for this target');
      const concurrentRange = useCached();
      if (concurrentRange) return concurrentRange;
      const version = randomUUID();
      rangeSnapshots.set(key, { patch, version, base: single ? `${rev}-` : from, head: single ? rev : to, files: modelPatch(patch).map(({ oldPath, newPath, parseError, status, oldMode, newMode }) => ({ oldPath, newPath, parseError, status, oldMode, newMode })) });
      while (rangeSnapshots.size > 32) rangeSnapshots.delete(rangeSnapshots.keys().next().value);
      return { patch, version, rangeKey };
    },
    async diffFiles({ operationId, fileIndex, version, rangeKey }) {
      await checkWorkspace();
      const activeCwd = resolveCwd(), started = generation;
      const snapshot = rangeKey ? rangeSnapshots.get(`${operationId}\0${rangeKey}`) : snapshots.get(operationId);
      if (version !== undefined && snapshot?.version !== version) throw new Error('Expansion is unavailable for this file or snapshot');
      const file = Number.isSafeInteger(fileIndex) && snapshot?.files[fileIndex];
      if (!file || file.parseError || !['modified', 'renamed', 'copied'].includes(file.status) || [file.oldMode, file.newMode].some(mode => mode && !['100644', '100755'].includes(mode))) throw new Error('Expansion is unavailable for this file or snapshot');
      const [oldContent, newContent] = await Promise.all([
        readFileAt(activeCwd, operationId, snapshot.base, file.oldPath),
        readFileAt(activeCwd, operationId, snapshot.head, file.newPath),
      ]);
      if (generation !== started) throw new Error('Expansion is unavailable for this file or snapshot');
      return { oldFile: { name: file.oldPath, contents: oldContent }, newFile: { name: file.newPath, contents: newContent } };
    },
    describe(request) {
      const result = pending.then(async () => {
        generation++; cached = undefined; stackCached = undefined;
        try { return await describe(request); }
        finally { generation++; cached = undefined; stackCached = undefined; }
      });
      pending = result.catch(() => {});
      return result;
    },
  };
}
