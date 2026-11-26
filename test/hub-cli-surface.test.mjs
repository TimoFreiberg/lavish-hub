import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import { ensureHubAssets } from '../src/deps.mjs';
import { parseArgs } from '../src/cli.mjs';
import { hubUrl } from '../src/hub-runtime.mjs';
import { computeHubUrl } from '../src/hub-url.mjs';
import { resolveWorkspace } from '../src/hub-workspace.mjs';
import { runtimeEnv, lavishCli } from '../src/runtime.mjs';

const cli = path.resolve('bin/lavish-hub');

test('publish help and conflicting scope flags', () => {
  const help = spawnSync(process.execPath, [cli, 'publish', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /lavish-hub publish review\.html\n/);
  assert.match(help.stdout, /--repo org\/repo --base-commit <hex> --head-commit <hex> --source-url https:\/\/github\.com\/org\/repo\/pull\/123/);
  assert.match(help.stdout, /lavish-hub publish notes\.html --no-scope/);
  for (const flag of ['--metadata-file', '--repo', '--base-commit', '--head-commit', '--source-url']) {
    assert.throws(() => parseArgs(['publish', 'review.html', '--no-scope', flag, 'value']), /--no-scope cannot be combined/);
  }
  const result = spawnSync(process.execPath, [cli, 'publish', 'review.html', '--no-scope', '--repo', 'value'], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /lavish-hub: \[USAGE_ERROR\] action=fix_args — --no-scope cannot be combined/);
});

test('session CLI flags, mandatory rev, and LAVISH_HUB_SESSION parsing and URL prediction', async t => {
  assert.throws(() => parseArgs(['listen', '--session', 'x']), /listen with --session requires --rev/);
  assert.throws(() => parseArgs(['listen', '--session', 'x', '--title', 'X']), /listen with --session requires --rev/);
  assert.deepEqual(parseArgs(['listen', '--session', 'x', '--rev', '@']), { hub: 'listen', session: 'x', rev: '@' });
  for (const args of [['listen', '--session', '../x', '--title', 'X', '--rev', '@'], ['listen', '--title', '  '], ['status', '--session', 'a/b']]) assert.throws(() => parseArgs(args));
  assert.deepEqual(parseArgs(['listen']), { hub: 'listen' });
  assert.deepEqual(parseArgs(['listen', '--session', 's', '--title', '  Review  ', '--rev', '@', '--base', 'main']), { hub: 'listen', session: 's', title: 'Review', rev: '@', base: 'main' });
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'session-url-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'), child = path.join(dir, 'child');
  await mkdir(repo); execFileSync('jj', ['git', 'init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('jj', ['workspace', 'add', child], { cwd: repo, stdio: 'ignore' });
  const env = { ...process.env, HOME: dir, XDG_DATA_HOME: path.join(dir, 'data'), LAVISH_AXI_STATE_DIR: path.join(dir, 'state'), LAVISH_HUB_SESSION: 'session-one' };
  const deps = { client: () => ({ verifyIfRunning: async () => null }) };
  const url = await hubUrl({ workspace: repo, env }, deps);
  assert.equal(await hubUrl({ workspace: child, env }, deps), url);
  assert.notEqual(await hubUrl({ workspace: repo, session: 'other', env }, deps), url);
  await assert.rejects(stat(path.join(dir, 'data')), { code: 'ENOENT' });
  for (const [args, session, pattern] of [
    [['listen', '--workspace', repo], 'abc', /listen with --session requires --rev/],
    [['listen', '--workspace', repo, '--title', 'Review'], 'abc', /listen with --session requires --rev/],
    [['status', '--workspace', repo], 'bad/session', /Invalid session ID/],
    [['reply', '--batch', 'id', 'text', '--workspace', repo], 'bad/session', /Invalid session ID/],
    [['context', '--batch', 'id', '--workspace', repo], 'bad/session', /Invalid session ID/],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { env: { ...env, LAVISH_HUB_SESSION: session }, encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, pattern);
  }
});

test('target command argument parsing', () => {
  assert.deepEqual(parseArgs(['target', '@-', '--base', 'main', '--title', ' Review ', '--session', 's']), { hub: 'target', rev: '@-', base: 'main', title: 'Review', session: 's' });
  assert.deepEqual(parseArgs(['target', '--no-base']), { hub: 'target', noBase: true });
  for (const args of [['target'], ['target', '--base', 'a', '--no-base'], ['target', '--rev', 'x'], ['target', '--title', '\n']]) assert.throws(() => parseArgs(args));
  assert.throws(() => parseArgs(['target', '--', '-rev']), /unknown argument/);
});

test('value-taking CLI flags accept leading hyphens and inline = values', () => {
  assert.deepEqual(
    parseArgs(['listen', '--title', '-draft', '--rev', '-rev', '--base', '-base', '--workspace', '-dir']),
    { hub: 'listen', title: '-draft', rev: '-rev', base: '-base', workspace: '-dir' },
  );
  assert.deepEqual(
    parseArgs(['listen', '--title=--draft=v1', '--rev=-rev', '--base=--base', '--workspace=-dir']),
    { hub: 'listen', title: '--draft=v1', rev: '-rev', base: '--base', workspace: '-dir' },
  );
  assert.deepEqual(
    parseArgs(['publish', 'review.html', '--metadata-file', '-meta.json', '--base-commit', '-abc']),
    { hub: 'publish', file: 'review.html', metadataFile: '-meta.json', baseCommit: '-abc' },
  );
  assert.deepEqual(
    parseArgs(['publish', 'review.html', '--head-commit=-def', '--source-url=-url']),
    { hub: 'publish', file: 'review.html', headCommit: '-def', sourceUrl: '-url' },
  );
  assert.deepEqual(parseArgs(['--view=-view']), { hub: 'status', view: '-view' });
  assert.deepEqual(parseArgs(['context', '--batch', '-batch', '--workspace=-dir']), { hub: 'context', batchId: '-batch', workspace: '-dir' });
  assert.deepEqual(parseArgs(['reply', '--batch=-batch', '--workspace', '-dir', '--agent-reply=--hello']), { hub: 'reply', batchId: '-batch', workspace: '-dir', text: '--hello' });
  assert.deepEqual(parseArgs(['reply', 'page-id', '--agent-reply=-draft']), { reply: true, page: 'page-id', text: '-draft' });

  for (const args of [
    ['listen', '--title='],
    ['listen', '--title'],
    ['listen', '--rev='],
    ['context', '--batch='],
    ['reply', '--batch', 'id', '--text='],
  ]) assert.throws(() => parseArgs(args), /requires one/);
  for (const args of [
    ['listen', '--open=true'],
    ['listen', '--reopen=1'],
    ['listen', '--no-base=1'],
    ['publish', 'review.html', '--no-scope=1'],
    ['reply', '--batch', 'id', '--=text'],
  ]) assert.throws(() => parseArgs(args), /unknown argument/);
  assert.throws(() => parseArgs(['status', '--session', '-bad']), /Invalid session ID/);
  assert.throws(() => parseArgs(['status', '--session=-bad']), /Invalid session ID/);
});

test('hub-only CLI rejects removed commands', () => {
  for (const command of ['hub', 'diff', 'file', 'pr', 'task', 'retarget', '-']) {
    const result = spawnSync(process.execPath, [cli, command], { encoding: 'utf8' });
    assert.equal(result.status, 2, `${command}: ${result.stderr}`);
    assert.match(result.stderr, /unknown command/);
  }
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /lavish-hub reply PAGE --agent-reply TEXT/);
});

test('reply parsing preserves argument boundaries', () => {
  for (const flag of ['--unknown-flag', '--help']) {
    assert.throws(() => parseArgs(['reply', '--batch', 'id', flag]), /unknown argument/);
    const result = spawnSync(process.execPath, [cli, 'reply', '--batch', 'id', flag], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
  }
  for (const prefix of [['--'], ['--text'], ['--agent-reply']]) {
    assert.equal(parseArgs(['reply', '--batch', 'id', ...prefix, '--literal']).text, '--literal');
  }
  assert.equal(parseArgs(['reply', '--batch', 'id', '- item']).text, '- item');
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
  assert.equal(defaults.LAVISH_AXI_STATE_DIR, path.join('/home/example', '.local/state/lavish-hub/lavish'));
  assert.equal(runtimeEnv({ HOME: '/home/example', XDG_STATE_HOME: '/state' }).LAVISH_AXI_STATE_DIR, '/state/lavish-hub/lavish');
  const explicit = runtimeEnv({ LAVISH_AXI_PORT: '1234', LAVISH_AXI_STATE_DIR: '/custom' });
  assert.equal(explicit.LAVISH_AXI_PORT, '1234');
  assert.equal(explicit.LAVISH_AXI_STATE_DIR, '/custom');
  assert.match(lavishCli, /vendor\/lavish\/dist\/cli\.mjs$/);
});

test('hub url parses arguments and predicts workspace session URLs without side effects', async t => {
  assert.deepEqual(parseArgs(['url']), { hub: 'url' });
  assert.deepEqual(parseArgs(['url', '--workspace', 'sub']), { hub: 'url', workspace: 'sub' });
  for (const args of [['url', '--open'], ['url', '--reopen'], ['url', '--view', 'commits']]) {
    assert.throws(() => parseArgs(args), /unknown argument/);
  }
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hub-url-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'), second = path.join(dir, 'second'), alias = path.join(dir, 'alias');
  await mkdir(repo);
  execFileSync('jj', ['git', 'init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('jj', ['workspace', 'add', second], { cwd: repo, stdio: 'ignore' });
  await symlink(dir, alias);
  const data = path.join(alias, 'data'), state = path.join(alias, 'state');
  const env = { ...process.env, HOME: dir, XDG_DATA_HOME: data, LAVISH_AXI_STATE_DIR: state, LAVISH_AXI_PORT: '45123', LAVISH_AXI_HOST: '127.0.0.1' };
  const identity = await resolveWorkspace(repo, env);
  const expectedKey = createHash('sha256').update(path.join(identity.directory, 'hub.html')).digest('hex').slice(0, 16);
  const predicted = await hubUrl({ workspace: repo, env }, { client: () => ({ verifyIfRunning: async () => null }) });
  assert.equal(predicted, `http://127.0.0.1:45123/session/${expectedKey}`);
  await assert.rejects(stat(path.join(dir, 'data')), { code: 'ENOENT' });
  const secondUrl = await hubUrl({ workspace: second, env }, { client: () => ({ verifyIfRunning: async () => null }) });
  assert.notEqual(secondUrl, predicted);

  const noServer = () => ({ verifyIfRunning: async () => null });
  assert.equal(await computeHubUrl(identity, { env: { ...env, LAVISH_AXI_HOST: '0.0.0.0' }, client: noServer }), `http://127.0.0.1:45123/session/${expectedKey}`);
  assert.equal(await computeHubUrl(identity, { env: { ...env, LAVISH_AXI_HOST: '::1' }, client: noServer }), `http://[::1]:45123/session/${expectedKey}`);
  assert.equal(await computeHubUrl(identity, { env: { ...env, LAVISH_AXI_LINK_HOST: 'review.example.test' }, client: noServer }), `http://review.example.test:45123/session/${expectedKey}`);
  const tailscaleEnv = { ...env };
  delete tailscaleEnv.LAVISH_AXI_HOST;
  const detect = async () => ({ ipv4: '100.64.0.9', magicDnsName: 'box.tailnet.ts.net' });
  assert.equal(await computeHubUrl(identity, { env: tailscaleEnv, detect, client: noServer }), `http://box.tailnet.ts.net:45123/session/${expectedKey}`);
  assert.equal(await computeHubUrl(identity, { env: tailscaleEnv, detect, client: () => ({ verifyIfRunning: async () => ({ hosts: ['127.0.0.1', '100.64.0.9'] }) }) }), `http://box.tailnet.ts.net:45123/session/${expectedKey}`);
  assert.equal(await computeHubUrl(identity, { env: tailscaleEnv, detect, client: () => ({ verifyIfRunning: async () => ({ hosts: ['127.0.0.1'] }) }) }), `http://127.0.0.1:45123/session/${expectedKey}`);
});
