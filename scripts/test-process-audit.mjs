import { execFileSync } from 'node:child_process';

export function markedProcesses(marker) {
  // Take one snapshot rather than starting ps once for every process on the host.
  // Never print this output: process environments can contain credentials.
  const env = { ...process.env }; delete env.LAVISH_KIT_TEST_RUN;
  const snapshot = execFileSync('ps', ['eww', '-A', '-o', 'pid=,command='], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const token = `LAVISH_KIT_TEST_RUN=${marker}`;
  return snapshot.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    return match && Number(match[1]) !== process.pid && match[2].split(/\s+/).includes(token) ? [Number(match[1])] : [];
  });
}
