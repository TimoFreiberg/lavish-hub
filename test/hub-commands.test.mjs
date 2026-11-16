import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHubCommands } from '../src/hub-commands.mjs';
import { readMetadata } from '../src/hub-documents.mjs';

test('command attempts are checkpointed, bounded and not replayed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-command-'));
  try {
    const commands = await createHubCommands(dir, dir);
    const marker = path.join(dir, 'marker');
    const body = { id: 'one', argv: [process.execPath, '-e', "require('fs').appendFileSync(process.argv[1], 'x'); process.stdout.write('a'.repeat(100000))", marker] };
    const result = await commands.execute(body);
    assert.equal(result.code, 0); assert.equal(result.truncated, true); assert.equal(Buffer.byteLength(result.stdout), 65536);
    assert.deepEqual(await commands.execute(body), result);
    assert.equal(await readFile(marker, 'utf8'), 'x');
    await writeFile(path.join(dir, 'attempts', 'lost.json'), '');
    assert.equal((await commands.execute({ ...body, id: 'lost' })).status, 'interrupted-or-running');
    assert.equal(await readFile(marker, 'utf8'), 'x');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing executable produces a durable receipt without stopping the owner', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-command-'));
  try {
    const commands = await createHubCommands(dir, dir);
    const body = { id: 'missing', argv: [path.join(dir, 'does-not-exist')] };
    const result = await commands.execute(body);
    assert.equal(result.status, 'finished');
    assert.match(result.error, /ENOENT/);
    assert.deepEqual(await commands.status(body), result);
    assert.deepEqual(await commands.execute(body), result);
    assert.equal((await commands.execute({ id: 'after', argv: [process.execPath, '-e', ''] })).code, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('running commands can be cancelled', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-command-'));
  try {
    const commands = await createHubCommands(dir, dir);
    const pending = commands.execute({ id: 'cancel', argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] });
    // Wait for the checkpoint; cancellation may arrive before spawning.
    while ((await commands.status({ id: 'cancel' }).catch(() => null)) === null) await new Promise(resolve => setImmediate(resolve));
    // execute() starts the child immediately after syncing the checkpoint.
    let cancelled;
    do { cancelled = await commands.cancel({ id: 'cancel' }); if (!cancelled.cancelled) await new Promise(resolve => setImmediate(resolve)); } while (!cancelled.cancelled);
    const result = await pending;
    assert.equal(result.cancelled, true); assert.equal(result.signal, 'SIGKILL');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('commands time out and retain the result', { timeout: 40000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-command-'));
  try {
    const commands = await createHubCommands(dir, dir);
    const body = { id: 'timeout', argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] };
    const result = await commands.execute(body);
    assert.equal(result.timedOut, true);
    assert.equal(result.signal, 'SIGKILL');
    assert.deepEqual(await commands.status(body), result);
    assert.deepEqual(await commands.execute(body), result);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('metadata input is bounded at 16 KiB', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-metadata-'));
  try {
    const file = path.join(dir, 'metadata.json');
    await writeFile(file, JSON.stringify({ reviewedRepository: 'x'.repeat(16350) }));
    assert.ok((await readMetadata(file)).reviewedRepository);
    await writeFile(file, ' '.repeat(16385));
    await assert.rejects(readMetadata(file), /exceeds 16 KiB/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
