import { spawn } from 'node:child_process';

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
    async snapshot({ force = false } = {}) {
      await checkWorkspace();
      while (true) {
        if (flight) { await flight; force = false; continue; }
        if (!force && cached && Date.now() < expires) return cached;
        const started = generation;
        const refresh = readHubSnapshot(cwd).then(value => {
          if (generation === started) { cached = value; expires = Date.now() + 2000; }
        });
        flight = refresh;
        try { await refresh; } finally { if (flight === refresh) flight = undefined; }
        force = false;
      }
    },
    async prHead(expression = '@-') {
      if (typeof expression !== 'string' || !expression.trim() || expression.length > 4096 || expression.includes('\0')) throw new Error('Invalid PR revision');
      await checkWorkspace();
      const op = await operation(cwd);
      const heads = await rows(cwd, op, expression);
      const working = await rows(cwd, op, '@');
      if (heads.length !== 1 || working.length !== 1) throw new Error('PR revision must resolve to exactly one commit');
      const changes = await run(cwd, ['--at-operation', op, 'diff', '-r', working[0].commitId, '--summary']);
      const warning = changes.trim() ? (expression === '@-' ? 'Working-copy changes are excluded by the default @- PR head.' : `The working copy has changes. The selected PR head is ${heads[0].commitId}${heads[0].commitId === working[0].commitId ? ' (the working-copy commit)' : ' (not the working-copy commit)'}.`) : null;
      return { revision: heads[0].commitId, expression, operationId: op, warning };
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
