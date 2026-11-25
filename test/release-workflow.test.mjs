import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { runReleaseChecks } from '../scripts/release-check.mjs';

test('release workflow gates publication on the same package passing both smoke jobs', async () => {
  const workflow = parse(await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  const { build, smoke, publish } = workflow.jobs;
  assert.equal(smoke.needs, 'build');
  assert.equal(publish.needs, 'smoke');
  assert.deepEqual(smoke.strategy.matrix.os, ['ubuntu-latest', 'macos-latest']);
  const step = (job, prefix) => job.steps.find(item => item.uses?.startsWith(prefix));
  const upload = step(build, 'actions/upload-artifact@');
  for (const job of [smoke, publish]) {
    assert.equal(step(job, 'actions/download-artifact@').with.name, upload.with.name);
    assert.match(job.steps.map(item => item.run || '').join('\n'), /shasum -a 256 -c SHA256SUMS/);
  }
  assert.match(smoke.steps.map(item => item.run || '').join('\n'), /node test\/package-smoke\.mjs release\/lavish-hub\.tgz/);
  const commands = build.steps.map(item => item.run || '').join('\n');
  assert.match(commands, /git merge-base --is-ancestor "\$SOURCE" origin\/main/);
  assert.match(commands, /gh release view/);
  assert.match(commands, /git ls-remote --tags/);
  assert.match(publish.steps.map(item => item.run || '').join('\n'), /gh release create/);
  assert.equal(publish.permissions.contents, 'write');
  assert.notEqual(build.permissions.contents, 'write');
  assert.notEqual(smoke.permissions.contents, 'write');
});

test('runReleaseChecks passes when version, availability, flake, and package checks succeed', async () => {
  const calls = [];
  const removed = [];
  const result = await runReleaseChecks({
    root: '/repo',
    nodePath: '/bin/node',
    log: () => {},
    readJson: async file => file.endsWith('package.json')
      ? { version: '0.3.0' }
      : { version: '0.3.0', packages: { '': { version: '0.3.0' } } },
    makeTempDir: async () => '/tmp/release-test',
    removeDir: async dir => removed.push(dir),
    run: (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'gh') return { status: 1, stdout: '', stderr: 'release not found\n' };
      if (cmd === 'nix' && args[0] === 'build') return { status: 0, stdout: '/nix/store/fake-lavish-hub\n', stderr: '' };
      if (cmd === 'nix' && args[0] === 'flake') return { status: 0, stdout: '', stderr: '' };
      if (cmd === '/nix/store/fake-lavish-hub/bin/lavish-hub') return { status: 0, stdout: 'usage: lavish-hub\n', stderr: '' };
      if (cmd === '/bin/node') return { status: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.version, '0.3.0');
  assert.deepEqual(result.checks.map(c => [c.name, c.ok]), [
    ['version', true],
    ['tag', true],
    ['release', true],
    ['flake', true],
    ['package', true],
  ]);
  assert.deepEqual(removed, ['/tmp/release-test']);
  assert.ok(calls.some(c => c[0] === 'nix' && c[1] === 'build'));
  assert.ok(calls.some(c => c[0] === 'nix' && c[1] === 'flake'));
  assert.ok(calls.some(c => c[0] === '/bin/node' && c[1] === 'scripts/package.mjs'));
  assert.ok(calls.some(c => c[0] === '/bin/node' && c[1] === 'test/package-smoke.mjs'));
});

test('runReleaseChecks reports stale lockfile, existing tag/release, gh errors, and flake failure without aborting early', async () => {
  const result = await runReleaseChecks({
    root: '/repo',
    nodePath: '/bin/node',
    log: () => {},
    readJson: async file => file.endsWith('package.json')
      ? { version: '0.2.2' }
      : { version: '0.2.2', packages: { '': { version: '0.2.2' } } },
    makeTempDir: async () => '/tmp/release-test',
    removeDir: async () => {},
    run: (cmd, args) => {
      if (cmd === 'git') return { status: 0, stdout: 'abc123\trefs/tags/v0.2.2\n', stderr: '' };
      if (cmd === 'gh') return { status: 1, stdout: '', stderr: 'authentication required\n' };
      if (cmd === 'nix' && args[0] === 'build') return { status: 1, stdout: '', stderr: 'ERROR: npmDepsHash is out of date\n' };
      if (cmd === '/bin/node') return { status: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    },
  });
  assert.equal(result.ok, false);
  const byName = Object.fromEntries(result.checks.map(c => [c.name, c]));
  assert.equal(byName.version.ok, true);
  assert.equal(byName.tag.ok, false);
  assert.match(byName.tag.detail, /already exists/);
  assert.equal(byName.release.ok, false);
  assert.match(byName.release.detail, /authentication required/);
  assert.equal(byName.flake.ok, false);
  assert.match(byName.flake.detail, /npmDepsHash is out of date/);
  assert.equal(byName.package.ok, true);
});

test('runReleaseChecks detects package-lock.json version mismatch and supports skipAvailability', async () => {
  const mismatch = await runReleaseChecks({
    root: '/repo',
    skipAvailability: true,
    nodePath: '/bin/node',
    log: () => {},
    readJson: async file => file.endsWith('package.json')
      ? { version: '0.3.0' }
      : { version: '0.2.2', packages: { '': { version: '0.2.2' } } },
    makeTempDir: async () => '/tmp/release-test',
    removeDir: async () => {},
    run: (cmd, args) => {
      if (cmd === 'nix' && args[0] === 'build') return { status: 0, stdout: '/nix/store/fake-lavish-hub\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(mismatch.ok, false);
  assert.deepEqual(mismatch.checks.map(c => c.name), ['version', 'flake', 'package']);
  assert.equal(mismatch.checks[0].ok, false);
  assert.match(mismatch.checks[0].detail, /does not match package\.json/);
});
