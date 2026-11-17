import { execFileSync } from 'node:child_process';

export function markedProcesses(marker) {
  // Take one snapshot rather than starting ps once for every process on the host.
  // Never print this output: process environments can contain credentials.
  const env = { ...process.env }; delete env.LAVISH_KIT_TEST_RUN;
  const snapshot = execFileSync('ps', ['eww', '-A', '-o', 'pid=,command='], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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
