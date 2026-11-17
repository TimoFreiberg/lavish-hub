import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { ensureHubAssets } from '../src/deps.mjs';
import { parseArgs } from '../src/cli.mjs';
import { runtimeEnv, lavishCli } from '../src/runtime.mjs';

const cli = path.resolve('bin/lavish-kit');

test('hub-only CLI rejects removed commands', () => {
  for (const command of ['diff', 'file', 'pr', 'task', 'retarget', '-']) {
    const result = spawnSync(process.execPath, [cli, command], { encoding: 'utf8' });
    assert.equal(result.status, 2, `${command}: ${result.stderr}`);
    assert.match(result.stderr, /unknown command/);
  }
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /lavish-kit reply PAGE --agent-reply TEXT/);
});

test('reply parsing preserves argument boundaries', () => {
  const text = 'spaces, quotes " and $characters\nsecond line';
  assert.deepEqual(parseArgs(['reply', 'page-id', '--agent-reply', text]), { reply: true, page: 'page-id', text });
  for (const args of [['reply'], ['reply', 'page', '--agent-reply'], ['reply', 'page', '--agent-reply', 'x', 'extra']]) {
    assert.throws(() => parseArgs(args), /reply requires/);
  }
});

test('missing hub assets retain their actionable error', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hub-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(ensureHubAssets({ root }), /Hub assets missing; build the package for development/);
});

test('runtime defaults and explicit overrides agree', () => {
  const defaults = runtimeEnv({ HOME: '/home/example' });
  assert.equal(defaults.LAVISH_AXI_PORT, '4388');
  assert.equal(defaults.LAVISH_AXI_STATE_DIR, path.join('/home/example', '.local/state/lavish-kit/lavish'));
  assert.equal(runtimeEnv({ HOME: '/home/example', XDG_STATE_HOME: '/state' }).LAVISH_AXI_STATE_DIR, '/state/lavish-kit/lavish');
  const explicit = runtimeEnv({ LAVISH_AXI_PORT: '1234', LAVISH_AXI_STATE_DIR: '/custom' });
  assert.equal(explicit.LAVISH_AXI_PORT, '1234');
  assert.equal(explicit.LAVISH_AXI_STATE_DIR, '/custom');
  assert.match(lavishCli, /vendor\/lavish\/dist\/cli\.mjs$/);
});
