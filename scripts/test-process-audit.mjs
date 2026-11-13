import { execFileSync } from 'node:child_process';

export function markedProcesses(marker) {
  const pids = execFileSync('ps', ['-A', '-o', 'pid='], { encoding: 'utf8' }).trim().split(/\s+/);
  const leaked = [];
  for (const pid of pids) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    try {
      // Never print process environments, which can contain credentials.
      const details = execFileSync('ps', ['eww', '-p', pid, '-o', 'command='], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      if (details.split(/\s+/).includes(`LAVISH_KIT_TEST_RUN=${marker}`)) leaked.push(Number(pid));
    } catch (error) {
      // A process may disappear between snapshots; other failures are unsafe to ignore.
      if (error.status !== 1) throw error;
    }
  }
  return leaked;
}
