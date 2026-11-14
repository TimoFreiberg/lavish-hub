import { spawn } from 'node:child_process';
import { mkdir, writeFile, rename, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');

export async function runChecks({ mode = 'all', directory, execute, publish, signal, shotsDirectory = '../../shots' } = {}) {
  if (!['all', 'test', 'e2e', 'shots'].includes(mode)) throw new Error('Expected all, test, e2e, or shots');
  const result = { version: 1, status: 'running', screenshotReviewRequired: mode === 'all' || mode === 'shots', stages: {} };
  const stage = async name => {
    if (signal?.aborted) return 1;
    const start = performance.now();
    let code;
    try { code = await execute(name, directory); if (signal?.aborted) code = 1; }
    catch (error) { result.stages[name] = { code: 1, error: error.message, seconds: (performance.now() - start) / 1000 }; await publish('status.json', result); return 1; }
    result.stages[name] = { code, seconds: (performance.now() - start) / 1000 };
    await publish('status.json', result);
    return code;
  };
  await publish('status.json', result);
  if (mode === 'all' || mode === 'test') {
    if (await stage('install')) { result.status = 'failed'; await publish('status.json', result); return result; }
  }
  if (mode === 'all' || mode === 'shots') {
    const code = await stage('shots');
    // Readiness means generation and cleanup finished, not that checks passed.
    await publish('screenshots-ready.json', { version: 1, status: code === 0 ? 'passed' : 'failed', directory: mode === 'all' ? 'shots' : shotsDirectory, reviewRequired: true });
    console.log(`Screenshots ready: ${directory}/screenshots-ready.json (inspection required)`);
  }
  if (mode === 'all') await Promise.all([stage('test'), stage('e2e')]);
  else if (mode !== 'shots') await stage(mode);
  result.status = signal?.aborted || Object.values(result.stages).some(stage => stage.code !== 0) ? 'failed' : 'passed';
  await publish('status.json', result);
  if (result.status === 'passed' && signal?.aborted) {
    result.status = 'failed';
    await publish('status.json', result);
  }
  return result;
}

async function main() {
  const mode = process.argv[2] || 'all';
  const lock = path.join(root, '.checks', 'lock');
  await mkdir(path.dirname(lock), { recursive: true });
  try { await mkdir(lock); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another correctness command owns .checks/lock; wait for it to finish (remove a stale lock only after confirming its owner stopped)'); throw error; }
  const directory = path.join(root, '.checks', `${Date.now()}-${randomUUID().slice(0, 8)}`);
  const cancellation = new AbortController(), children = new Set();
  let finalized = false;
  const cancel = signal => {
    if (finalized) return;
    cancellation.abort(signal);
    process.exitCode = 1;
    for (const child of children) child.kill(signal);
  };
  const interrupt = () => cancel('SIGINT'), terminate = () => cancel('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, directory }));
    await mkdir(directory);
    console.log(`Correctness artifacts: ${directory}`);
    const publish = async (name, value) => {
      const destination = path.join(directory, name), temporary = `${destination}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, destination);
    };
    const execute = async name => {
      const log = await open(path.join(directory, `${name}.log`), 'w');
      const args = name === 'install' ? ['ci'] : ['scripts/test-run.mjs', name];
      const env = { ...process.env };
      if (mode === 'all') env.LAVISH_KIT_SHOTS_DIR = path.join(directory, 'shots');
      console.log(`Starting ${name}; log: ${directory}/${name}.log`);
      try {
        if (cancellation.signal.aborted) return 1;
        return await new Promise((resolve, reject) => {
          const child = spawn(name === 'install' ? 'npm' : process.execPath, args, { cwd: root, env, stdio: ['ignore', log.fd, log.fd] });
          children.add(child);
          child.once('error', error => { children.delete(child); reject(error); });
          child.once('exit', code => {
            children.delete(child);
            const status = cancellation.signal.aborted ? 1 : (code ?? 1);
            console.log(`${name}: ${status === 0 ? 'PASS' : 'FAIL'}`);
            resolve(status);
          });
        });
      } finally { await log.close(); }
    };
    const shotsDirectory = process.env.LAVISH_KIT_SHOTS_DIR ? path.resolve(process.env.LAVISH_KIT_SHOTS_DIR) : '../../shots';
    const result = await runChecks({ mode, directory, execute, publish, signal: cancellation.signal, shotsDirectory });
    // Publication completes the result; later signals must not change only the exit code.
    finalized = true;
    console.log(`Correctness ${result.status}: ${directory}/status.json${result.screenshotReviewRequired ? '; screenshot inspection still required' : ''}`);
    process.exitCode = result.status === 'passed' ? 0 : 1;
  } finally {
    try { await rm(lock, { recursive: true, force: true }); }
    finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
