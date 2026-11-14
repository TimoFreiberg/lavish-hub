import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanupTerminals } from './relay-e2e-cleanup.mjs';

test('e2e_cleanup_failure_validation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'relay-cleanup-test-'));
  try {
    for (const kind of ['malformed', 'unreadable', 'remove', 'missing']) {
      const dir = path.join(root, kind), journal = path.join(dir, 'terminal.json'), calls = [];
      await mkdir(dir);
      if (kind === 'malformed') await writeFile(journal, '{');
      if (kind === 'unreadable') await mkdir(journal);
      if (kind === 'remove') await writeFile(journal, JSON.stringify('t1'));
      const run = async (_, [command, id]) => {
        calls.push(`${command}:${id}`);
        if (kind === 'remove' && command === 'rm' && id === 't1') throw new Error('still alive');
        if (command === 'kill') throw new Error('already exited');
      };
      const cleanup = cleanupTerminals({ journal, terminals: ['t1', 't2'], dir, run });
      if (kind === 'missing') { await cleanup; await assert.rejects(access(dir)); }
      else { await assert.rejects(cleanup, /scratch evidence retained/); await access(dir); }
      assert.deepEqual(calls, ['kill:t1', 'rm:t1', 'kill:t2', 'rm:t2']);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
