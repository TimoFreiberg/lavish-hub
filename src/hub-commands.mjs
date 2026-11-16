import { spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const outputLimit = 64 * 1024;
const timeoutMs = 30_000;

// A checkpoint is created exclusively before spawn. Existing checkpoints are
// never replayed, including when the owner died before recording completion.
export async function createHubCommands(directory, cwd, validate = async () => true) {
  const attempts = path.join(directory, 'attempts');
  await mkdir(attempts, { recursive: true, mode: 0o700 });
  const running = new Map();
  let closing = false;
  const fileFor = id => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid request ID');
    return path.join(attempts, `${id}.json`);
  };
  const read = async id => {
    try { return JSON.parse(await readFile(fileFor(id), 'utf8')); }
    catch (error) { if (error instanceof SyntaxError) return { id, status: 'interrupted-or-running' }; throw error; }
  };
  const kill = child => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  return {
    async execute(body) {
      const file = fileFor(body.id);
      if (!Array.isArray(body.argv) || !body.argv.length || body.argv.length > 128 || body.argv.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 8192) || (body.stdin !== undefined && (typeof body.stdin !== 'string' || Buffer.byteLength(body.stdin) > 32768))) throw new Error('Invalid command');
      if (!(await validate())) throw new Error('Workspace is unavailable or has changed');
      let checkpoint;
      try { checkpoint = await open(file, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') return read(body.id); throw error; }
      try { await checkpoint.writeFile(JSON.stringify({ id: body.id, status: 'interrupted-or-running' })); await checkpoint.sync(); }
      finally { await checkpoint.close(); }
      let result;
      try {
        if (closing) throw new Error('Hub owner is stopping');
        result = await new Promise(resolve => {
          const child = spawn(body.argv[0], body.argv.slice(1), { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
          const state = { child, cancelled: false, timedOut: false };
          running.set(body.id, state);
          let remaining = outputLimit, stdout = [], stderr = [], truncated = false, failure;
          const collect = target => chunk => { const part = chunk.subarray(0, remaining); target.push(part); remaining -= part.length; if (part.length < chunk.length) truncated = true; };
          child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
          child.on('error', error => { failure = error.message; });
          child.stdin.on('error', () => {});
          child.stdin.end(body.stdin || '');
          const timer = setTimeout(() => { state.timedOut = true; kill(child); }, timeoutMs);
          child.on('close', (code, signal) => {
            clearTimeout(timer); kill(child); running.delete(body.id);
            resolve({ id: body.id, status: 'finished', code, signal, timedOut: state.timedOut, cancelled: state.cancelled, truncated, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), ...(failure ? { error: failure } : {}) });
          });
        });
      } catch (error) { result = { id: body.id, status: 'finished', error: error.message }; }
      await writeFile(file, JSON.stringify(result), { mode: 0o600 });
      return result;
    },
    async status(body) { return read(body.id); },
    async cancel(body) {
      fileFor(body.id);
      const state = running.get(body.id);
      if (!state) return { cancelled: false };
      state.cancelled = true; kill(state.child);
      return { cancelled: true };
    },
    close() { closing = true; for (const state of running.values()) { state.cancelled = true; kill(state.child); } },
  };
}
