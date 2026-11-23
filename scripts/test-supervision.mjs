import { spawn } from 'node:child_process';
import { markedProcesses } from './test-process-audit.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Only processes in the private process group or bearing this run's marker are signalled.
export async function runSupervised(args, { env, timeout, signal, grace = 2000, audit = markedProcesses, kill = process.kill }) {
  if (signal?.aborted) return { code: 1, cancelled: true };
  const child = spawn(process.execPath, args, { env, stdio: 'inherit', detached: true });
  const exited = new Promise(resolve => {
    child.once('error', error => resolve({ code: 1, error }));
    child.once('exit', (code, exitSignal) => resolve({ code: code ?? 1, signal: exitSignal }));
  });
  let timer, abort;
  const interrupted = new Promise(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeout);
    abort = () => resolve('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  const result = await Promise.race([exited, interrupted]);
  clearTimeout(timer);
  signal?.removeEventListener('abort', abort);
  if (typeof result !== 'string') return result;

  const failures = [];
  const send = (pid, sig) => {
    try { kill(pid, sig); } catch (error) {
      // macOS reports EPERM when every member of our own group has exited but
      // is not yet reaped; the audit and exit check still catch real survivors.
      if (error.code !== 'ESRCH' && !(pid < 0 && error.code === 'EPERM')) failures.push(error);
    }
  };
  // Capture marked detached children before stopping their parent; scan again after
  // the grace period for children created during shutdown.
  const stop = sig => {
    let pids = [];
    try { pids = audit(env.LAVISH_HUB_TEST_RUN); } catch (error) { failures.push(error); }
    for (const pid of pids) send(pid, sig);
    if (child.pid) send(-child.pid, sig);
  };
  stop('SIGTERM');
  await delay(grace);
  stop('SIGKILL');
  const exitResult = await Promise.race([exited, delay(grace).then(() => null)]);
  if (!exitResult) {
    child.unref();
    failures.push(new Error('Test process did not exit after SIGKILL'));
  }
  const error = failures.length ? new AggregateError(failures, `Test cleanup failed: ${failures.map(failure => failure.message).join('; ')}`) : undefined;
  return { code: 1, [result === 'timeout' ? 'timedOut' : 'cancelled']: true, ...(error && { error }) };
}
