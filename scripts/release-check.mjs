import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function defaultRun(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null,
  };
}

function formatFailure(result) {
  if (result.error) return result.error.message;
  const output = `${result.stderr}\n${result.stdout}`.trim();
  if (!output) return `exited with status ${result.status}`;
  const lines = output.split(/\r?\n/).filter(Boolean);
  return lines.slice(-6).join(' | ');
}

export async function runReleaseChecks({
  root = defaultRoot,
  skipAvailability = false,
  run = defaultRun,
  readJson = async file => JSON.parse(await readFile(file, 'utf8')),
  makeTempDir = () => mkdtemp(path.join(os.tmpdir(), 'lavish-hub-release-check-')),
  removeDir = dir => rm(dir, { recursive: true, force: true }),
  nodePath = process.execPath,
  log = message => console.log(message),
} = {}) {
  const checks = [];
  const record = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  };

  let version = null;
  try {
    const pkg = await readJson(path.join(root, 'package.json'));
    const lock = await readJson(path.join(root, 'package-lock.json'));
    if (!/^\d+\.\d+\.\d+$/.test(pkg.version || '')) {
      record('version', false, `package.json version "${pkg.version ?? ''}" must match X.Y.Z`);
    } else if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
      record('version', false, `package-lock.json version (${lock.version ?? 'missing'} / ${lock.packages?.['']?.version ?? 'missing'}) does not match package.json (${pkg.version})`);
    } else {
      version = pkg.version;
      record('version', true, `v${version} matches package-lock.json`);
    }
  } catch (error) {
    record('version', false, error.message);
  }

  if (!skipAvailability) {
    if (!version) {
      record('tag', false, 'skipped because version check failed');
      record('release', false, 'skipped because version check failed');
    } else {
      const tag = `v${version}`;
      const tagResult = run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], root);
      if (tagResult.error || tagResult.status !== 0) {
        record('tag', false, `git ls-remote failed: ${formatFailure(tagResult)}`);
      } else if (tagResult.stdout.trim()) {
        record('tag', false, `tag ${tag} already exists on origin`);
      } else {
        record('tag', true, `tag ${tag} does not exist on origin`);
      }

      const releaseResult = run('gh', ['release', 'view', tag, '--json', 'tagName'], root);
      if (!releaseResult.error && releaseResult.status === 0) {
        record('release', false, `GitHub release ${tag} already exists`);
      } else if (!releaseResult.error && /release not found/i.test(`${releaseResult.stderr}\n${releaseResult.stdout}`)) {
        record('release', true, `GitHub release ${tag} does not exist`);
      } else {
        record('release', false, `gh release view failed: ${formatFailure(releaseResult)}`);
      }
    }
  }

  const nixBuild = run('nix', ['build', '--no-link', '--print-out-paths'], root);
  if (nixBuild.error || nixBuild.status !== 0) {
    record('flake', false, `nix build failed: ${formatFailure(nixBuild)}`);
  } else {
    const outPath = nixBuild.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    const flakeCheck = run('nix', ['flake', 'check'], root);
    if (flakeCheck.error || flakeCheck.status !== 0) {
      record('flake', false, `nix flake check failed: ${formatFailure(flakeCheck)}`);
    } else if (!outPath) {
      record('flake', false, 'nix build produced no output path');
    } else {
      const binHelp = run(path.join(outPath, 'bin', 'lavish-hub'), ['--help'], root);
      if (binHelp.error || binHelp.status !== 0) {
        record('flake', false, `Nix binary --help failed: ${formatFailure(binHelp)}`);
      } else {
        record('flake', true, `nix build, nix flake check, and binary --help passed (${outPath})`);
      }
    }
  }

  let tempDir;
  try {
    tempDir = await makeTempDir();
    const pack = run(nodePath, ['scripts/package.mjs', tempDir], root);
    if (pack.error || pack.status !== 0) {
      record('package', false, `scripts/package.mjs failed: ${formatFailure(pack)}`);
    } else {
      const smoke = run(nodePath, ['test/package-smoke.mjs', path.join(tempDir, 'lavish-hub.tgz')], root);
      if (smoke.error || smoke.status !== 0) {
        record('package', false, `test/package-smoke.mjs failed: ${formatFailure(smoke)}`);
      } else {
        record('package', true, 'package build and smoke test passed');
      }
    }
  } catch (error) {
    record('package', false, error.message);
  } finally {
    if (tempDir) await removeDir(tempDir);
  }

  const ok = checks.every(check => check.ok);
  return { ok, version, checks };
}

async function main() {
  const args = process.argv.slice(2);
  let skipAvailability = false;
  for (const arg of args) {
    if (arg === '--skip-availability') skipAvailability = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/release-check.mjs [--skip-availability]');
      return;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  const result = await runReleaseChecks({ skipAvailability });
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
