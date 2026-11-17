import { execFileSync } from 'node:child_process';

export function markedProcesses(marker) {
  // Take one snapshot rather than starting ps once for every process on the host.
  // Never print this output: process environments can contain credentials.
  const env = { ...process.env }; delete env.LAVISH_KIT_TEST_RUN;
  let snapshot;
  try {
    snapshot = execFileSync('ps', ['eww', '-A', '-o', 'pid=,command='], {
      env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 5000, killSignal: 'SIGKILL',
    });
  } catch (error) {
    if (error.code === 'ETIMEDOUT') throw new Error('Process scan timed out after 5000ms', { cause: error });
    throw new Error(`Process scan failed${error.code ? ` (${error.code})` : ''}`, { cause: error });
  }
  const prefix = 'LAVISH_KIT_TEST_RUN=';
  return snapshot.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    const marked = match?.[2].split(/\s+/).some(token => {
      if (!token.startsWith(prefix)) return false;
      const value = token.slice(prefix.length);
      return value === marker || value.startsWith(`${marker},`);
    });
    return marked && Number(match[1]) !== process.pid ? [Number(match[1])] : [];
  });
}
