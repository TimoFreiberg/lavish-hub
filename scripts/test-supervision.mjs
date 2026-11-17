import { spawn } from 'node:child_process';
import { markedProcesses } from './test-process-audit.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Only processes in the private process group or bearing this run's marker are signalled.
export async function runSupervised(args, { env, timeout, signal, grace = 2000 }) {
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

  const send = (pid, sig) => {
    try { process.kill(pid, sig); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  // Capture marked detached children before stopping their parent; scan again after
  // the grace period for children created during shutdown.
  const stop = sig => {
    let failure;
    try { for (const pid of markedProcesses(env.LAVISH_KIT_TEST_RUN)) send(pid, sig); }
    catch (error) { failure = error; }
    try { if (child.pid) send(-child.pid, sig); } catch (error) { failure ??= error; }
    return failure;
  };
  let cleanupError = stop('SIGTERM');
  await delay(grace);
  cleanupError ??= stop('SIGKILL');
  // Always attempt escalation, even if the first scan failed.
  if (cleanupError) stop('SIGKILL');
  await exited;
  return { code: 1, [result === 'timeout' ? 'timedOut' : 'cancelled']: true, ...(cleanupError && { error: cleanupError }) };
}
