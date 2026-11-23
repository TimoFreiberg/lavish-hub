import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordWorkspace, resolveRecordedWorkspace, resolveWorkspace, workspaceMatches } from '../src/hub-workspace.mjs';
import { createHubTransport } from '../src/hub-transport.mjs';

test('hub workspace identity distinguishes workspaces and detects replacement', async t => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hub-workspace-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo'), second = path.join(dir, 'second');
  await mkdir(root); execFileSync('jj', ['git', 'init'], { cwd: root, stdio: 'ignore' });
  await mkdir(path.join(root, 'sub'));
  execFileSync('jj', ['workspace', 'add', second], { cwd: root, stdio: 'ignore' });
  const env = { XDG_DATA_HOME: path.join(dir, 'data'), LAVISH_AXI_STATE_DIR: path.join(dir, 'state') };
  const a = await resolveWorkspace(root, env), sub = await resolveWorkspace(path.join(root, 'sub'), env), b = await resolveWorkspace(second, env);
  assert.equal(a.directory, sub.directory); assert.notEqual(a.directory, b.directory);
  assert.equal(a.repo, b.repo); assert.equal(await workspaceMatches(a), true);
  // A workspace added beside the primary keeps its repo in a `.jj/repo` file.
  assert.equal(await workspaceMatches(b), true);
  assert.notEqual(a.directory, (await resolveWorkspace(root, { ...env, LAVISH_AXI_STATE_DIR: path.join(dir, 'other') })).directory);
  const defaults = { HOME: dir, XDG_DATA_HOME: env.XDG_DATA_HOME, XDG_STATE_HOME: path.join(dir, 'xdg-state') };
  assert.equal((await resolveWorkspace(root, defaults)).directory, (await resolveWorkspace(root, { ...defaults, LAVISH_AXI_STATE_DIR: path.join(defaults.XDG_STATE_HOME, 'lavish-hub', 'lavish') })).directory);
  await symlink(dir, path.join(dir, 'alias'));
  const aliasEnv = { XDG_DATA_HOME: path.join(dir, 'alias', 'data'), LAVISH_AXI_STATE_DIR: path.join(dir, 'alias', 'state') };
  assert.equal((await resolveWorkspace(root, aliasEnv)).directory, a.directory);
  await recordWorkspace(a);
  await rename(root, path.join(dir, 'old'));
  assert.deepEqual(await resolveRecordedWorkspace(root, aliasEnv), a);
  assert.equal(await workspaceMatches(a), false);
  await mkdir(root);
  execFileSync('jj', ['git', 'init'], { cwd: root, stdio: 'ignore' });
  assert.equal(await workspaceMatches(a), false);
});

test('hub transport requires capability even after opaque-origin preflight', async t => {
  let calls = 0;
  const hub = await createHubTransport({ echo: body => { calls++; return body.value; } });
  t.after(() => hub.close());
  const endpoint = `${hub.url}/action`;
  const preflight = await fetch(endpoint, { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, x-lavish-capability' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), 'null');
  const send = (headers, body = JSON.stringify({ operation: 'echo', value: 'ok' })) => fetch(endpoint, { method: 'POST', headers: { origin: 'null', 'content-type': 'application/json', ...headers }, body });
  assert.equal((await send({})).status, 403);
  assert.equal((await send({ 'x-lavish-capability': 'wrong' })).status, 403);
  assert.equal((await send({ 'x-lavish-capability': hub.capability, origin: 'https://example.com' })).status, 403);
  assert.equal((await send({ 'x-lavish-capability': hub.capability }, 'x'.repeat(65537))).status, 413);
  assert.equal(calls, 0);
  const result = await send({ 'x-lavish-capability': hub.capability });
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { result: 'ok' }); assert.equal(calls, 1);
  const other = await createHubTransport({ echo: () => { calls++; } });
  t.after(() => other.close());
  assert.equal((await fetch(`${other.url}/action`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lavish-capability': hub.capability }, body: '{"operation":"echo"}' })).status, 403);
  assert.equal(calls, 1);
});

test('resource guards recheck workspace identity without spawning jj', async t => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hub-guard-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo');
  await mkdir(root); execFileSync('jj', ['git', 'init'], { cwd: root, stdio: 'ignore' });
  const env = { XDG_DATA_HOME: path.join(dir, 'data'), LAVISH_AXI_STATE_DIR: path.join(dir, 'state') };
  const identity = await resolveWorkspace(root, env);
  const stub = path.join(dir, 'bin'), marker = path.join(dir, 'jj-calls');
  await mkdir(stub);
  const binary = path.join(stub, 'jj');
  await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${marker}'\nexit 1\n`);
  await chmod(binary, 0o700);
  const search = process.env.PATH;
  process.env.PATH = `${stub}${path.delimiter}${search}`;
  t.after(() => { process.env.PATH = search; });
  // Every resource read rechecks identity; a jj subprocess per check would
  // make each served asset wait on a process spawn.
  assert.equal(await workspaceMatches(identity), true);
  assert.equal(await readFile(marker, 'utf8').catch(() => ''), '');
  await rename(root, path.join(dir, 'old'));
  assert.equal(await workspaceMatches(identity), false);
});

test('workspace identity change detection covers a file-linked workspace', async t => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hub-identity-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo'), second = path.join(dir, 'second'), other = path.join(dir, 'other');
  await mkdir(root); execFileSync('jj', ['git', 'init'], { cwd: root, stdio: 'ignore' });
  execFileSync('jj', ['workspace', 'add', second], { cwd: root, stdio: 'ignore' });
  await mkdir(other); execFileSync('jj', ['git', 'init'], { cwd: other, stdio: 'ignore' });
  const env = { XDG_DATA_HOME: path.join(dir, 'data'), LAVISH_AXI_STATE_DIR: path.join(dir, 'state') };
  const identity = await resolveWorkspace(second, env);
  const link = path.join(second, '.jj', 'repo');
  const original = await readFile(link, 'utf8');
  assert.equal(path.relative(path.dirname(link), identity.repo), original.trim());
  assert.equal(await workspaceMatches(identity), true);
  // Repointing the workspace at another repository is a different workspace.
  await writeFile(link, path.relative(path.dirname(link), path.join(other, '.jj', 'repo')));
  assert.equal(await workspaceMatches(identity), false);
  await writeFile(link, original);
  assert.equal(await workspaceMatches(identity), true);
  // Replacing the whole workspace metadata is also a new identity.
  await rename(path.join(second, '.jj'), path.join(dir, 'previous-jj'));
  execFileSync('jj', ['git', 'init'], { cwd: second, stdio: 'ignore' });
  assert.equal(await workspaceMatches(identity), false);
  // The recorded root is compared as a path, so an identity naming an alias of
  // the same tree is not the workspace that was recorded.
  await symlink(second, path.join(dir, 'alias'));
  assert.equal(await workspaceMatches({ ...identity, root: path.join(dir, 'alias') }), false);
});
