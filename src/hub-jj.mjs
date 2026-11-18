import { spawn } from 'node:child_process';
import { modelPatch } from './diff/model.mjs';

const MAX_FILE_BYTES = 1024 * 1024;

function readFileAt(cwd, op, revision, file) {
  return new Promise((resolve, reject) => {
    const child = spawn('jj', ['--no-pager', '--color=never', '--at-operation', op, 'file', 'show', '-r', revision, '--', `root:${file}`], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = []; let size = 0, tooLarge = false;
    child.stdout.on('data', chunk => { size += chunk.length; if (size > MAX_FILE_BYTES) { tooLarge = true; child.kill(); } else chunks.push(chunk); });
    child.on('error', reject);
    child.on('close', code => {
      if (code || tooLarge) return reject(new Error('File content is unavailable or too large'));
      const bytes = Buffer.concat(chunks);
      try {
        if (bytes.includes(0)) throw new Error();
        resolve(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch { reject(new Error('File content is not supported text')); }
    });
  });
}

const fields = ['change_id', 'commit_id', 'description', 'immutable', 'divergent'];
const template = `"[" ++ ${fields.map(field => `json(${field})`).join(' ++ "," ++ ')} ++ "]\\n"`;

function run(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('jj', ['--no-pager', '--color=never', ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.on('close', code => code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(`jj ${args[0]} failed: ${Buffer.concat(err).toString('utf8').trim() || `exit ${code}`}`)));
    child.stdin.end(input);
  });
}

function parseRows(text) {
  return text.split('\n').filter(Boolean).map(line => {
    const [changeId, commitId, description, immutable, divergent] = JSON.parse(line);
    return { changeId, commitId, description, immutable, divergent };
  });
}

async function operation(cwd) {
  // A normal command snapshots the working copy before we capture the operation.
  await run(cwd, ['status']);
  const id = (await run(cwd, ['op', 'log', '-n', '1', '--no-graph', '-T', 'id ++ "\\n"'])).trim();
  if (!/^[0-9a-f]{128}$/.test(id)) throw new Error('Could not determine the current jj operation');
  return id;
}

async function rows(cwd, op, revset) {
  return parseRows(await run(cwd, ['--at-operation', op, 'log', '-r', revset, '--no-graph', '-T', template]));
}

export async function readHubSnapshot(cwd, { afterMetadata } = {}) {
  const op = await operation(cwd);
  const baseRows = await rows(cwd, op, 'fork_point(trunk() | @)');
  const headRows = await rows(cwd, op, '@');
  if (baseRows.length !== 1 || headRows.length !== 1) throw new Error('The jj base and working-copy head must each resolve to one commit');
  const base = baseRows[0].commitId, head = headRows[0].commitId;
  const commits = await rows(cwd, op, `${base}..${head}`);
  if (afterMetadata) await afterMetadata();
  const args = ['--at-operation', op, '--config', 'diff.git.show-path-prefix=true', 'diff', '--from', base, '--to', head];
  const [patch, commitStats] = await Promise.all([
    run(cwd, [...args, '--git']),
    Promise.all(commits.map(commit => run(cwd, ['--at-operation', op, 'diff', '-r', commit.commitId, '--stat']))),
  ]);
  commits.forEach((commit, index) => { commit.stat = commitStats[index]; });
  return { operationId: op, base, head, commits, patch, generated: new Date().toISOString() };
}

export function createHubJj(cwd, { validate = async () => true, beforeDescribe } = {}) {
  let pending = Promise.resolve(), cached, expires = 0, flight, generation = 0;
  const snapshots = new Map();
  async function checkWorkspace() {
    if (!await validate()) throw new Error('Workspace no longer matches its recorded repository');
  }
  async function versions(changeId) {
    const op = await operation(cwd);
    return rows(cwd, op, `change_id(${changeId})`).then(items => items.filter(item => item.changeId === changeId));
  }
  async function describe(request) {
    const { changeId, commitId, expectedDescription, description } = request;
    if (!/^[a-z]{32}$/.test(changeId || '') || !/^[0-9a-f]{40,128}$/.test(commitId || '') || typeof expectedDescription !== 'string' || typeof description !== 'string' || description.includes('\0')) throw new Error('Invalid description request');
    await checkWorkspace();
    const current = await versions(changeId);
    if (current.length !== 1 || current[0].divergent) return { status: 'conflict', reason: current.length ? 'divergent' : 'missing', current };
    if (current[0].immutable) return { status: 'conflict', reason: 'immutable', current };
    if (current[0].commitId !== commitId || current[0].description !== expectedDescription) return { status: 'conflict', reason: 'stale', current };
    if (beforeDescribe) await beforeDescribe();
    await checkWorkspace();
    await run(cwd, ['describe', '-r', commitId, '--stdin'], description);
    const updated = await versions(changeId);
    // jj normalizes a nonempty description to end in a newline.
    const intended = description && !description.endsWith('\n') ? `${description}\n` : description;
    if (updated.length !== 1 || updated[0].divergent || updated[0].description !== intended) return { status: 'conflict', reason: 'unexpected-result', current: updated };
    return { status: 'saved', current: updated[0] };
  }
  return {
    async summary() {
      await checkWorkspace();
      const result = parseRows(await run(cwd, ['log', '-r', '@-', '--no-graph', '-T', template]));
      if (result.length !== 1) throw new Error('Working-copy parent unavailable');
      return result[0].description.split('\n')[0].slice(0, 240) || '(no description)';
    },
    async snapshot({ force = false } = {}) {
      await checkWorkspace();
      while (true) {
        if (flight) { await flight; force = false; continue; }
        if (!force && cached && Date.now() < expires) return cached;
        const started = generation;
        const refresh = readHubSnapshot(cwd).then(value => {
          if (generation === started) {
            cached = value; expires = Date.now() + 2000;
            snapshots.delete(value.operationId);
            snapshots.set(value.operationId, { ...value, files: modelPatch(value.patch) });
            while (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value);
          }
        });
        flight = refresh;
        try { await refresh; } finally { if (flight === refresh) flight = undefined; }
        force = false;
      }
    },
    async diffFiles({ operationId, fileIndex }) {
      await checkWorkspace();
      const snapshot = snapshots.get(operationId);
      const file = Number.isSafeInteger(fileIndex) && snapshot?.files[fileIndex];
      if (!file || file.parseError || !['modified', 'renamed', 'copied'].includes(file.status) || [file.oldMode, file.newMode].some(mode => mode && !['100644', '100755'].includes(mode))) throw new Error('Expansion is unavailable for this file or snapshot');
      const [oldContent, newContent] = await Promise.all([
        readFileAt(cwd, operationId, snapshot.base, file.oldPath),
        readFileAt(cwd, operationId, snapshot.head, file.newPath),
      ]);
      return { oldFile: { name: file.oldPath, contents: oldContent }, newFile: { name: file.newPath, contents: newContent } };
    },
    describe(request) {
      const result = pending.then(async () => {
        generation++; cached = undefined;
        try { return await describe(request); }
        finally { generation++; cached = undefined; }
      });
      pending = result.catch(() => {});
      return result;
    },
  };
}
