import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || '.');
const source = process.env.LAVISH_KIT_SOURCE_COMMIT || execFileSync('jj', ['log', '-r', '@', '--no-graph', '-T', 'commit_id'], { cwd: root, encoding: 'utf8' }).trim();
const temp = await mkdtemp(path.join(os.tmpdir(), 'lavish-kit-package-'));
const run = (cmd, args, cwd, env = process.env) => execFileSync(cmd, args, { cwd, env, stdio: 'inherit' });
try {
  for (const name of ['package.json', 'package-lock.json', 'build.mjs', 'bin', 'src', 'web', 'vendor', 'LICENSE', 'docs']) {
    await cp(path.join(root, name), path.join(temp, name), { recursive: true, filter: source => !source.includes(`${path.sep}node_modules`) && !source.includes(`${path.sep}dist${path.sep}`) && !source.endsWith(`${path.sep}dist`) });
  }
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], temp);
  await mkdir(path.join(temp, 'dist'));
  run(process.execPath, ['build.mjs', temp, path.join(temp, 'dist')], temp);
  const vendor = path.join(temp, 'vendor/lavish');
  await symlink(path.join(temp, 'node_modules'), path.join(vendor, 'node_modules'), 'dir');
  const env = { ...process.env, LAVISH_AXI_UMAMI_HOST: '', LAVISH_AXI_UMAMI_WEBSITE_ID: '' };
  run(process.execPath, ['scripts/build.js'], vendor, env);
  await rm(path.join(vendor, 'node_modules'));
  await writeFile(path.join(vendor, '.npmignore'), 'node_modules\n');
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], temp);
  const pkg = JSON.parse(await readFile(path.join(temp, 'package.json'), 'utf8'));
  pkg.bundledDependencies = Object.keys(pkg.dependencies);
  pkg.files = ['bin', 'src/cli.mjs', 'src/deps.mjs', 'src/orangebox.mjs', 'src/hub-*.mjs', 'src/lavish.mjs', 'src/lavish-http.mjs', 'src/quote.mjs', 'src/runtime.mjs', 'src/save.mjs', 'src/save-message.mjs', 'web/hub-app.mjs', 'web/hub.css', 'web/confirm-navigation.js', 'dist/diff-app.js', 'dist/diff.css', 'dist/hub-markdown.js', 'dist/document.css', 'vendor/lavish/package.json', 'vendor/lavish/dist', 'vendor/lavish/LICENSE', 'vendor/lavish/THIRD-PARTY-NOTICES.md', 'LICENSE', 'docs', 'provenance.json'];
  await writeFile(path.join(temp, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  await writeFile(path.join(temp, 'provenance.json'), JSON.stringify({ source, lavishVersion: '0.1.97', lavishKitPageReviews: 1 }, null, 2) + '\n');
  await mkdir(output, { recursive: true });
  run('npm', ['pack', '--ignore-scripts', '--pack-destination', output], temp);
  const packed = path.join(output, `lavish-kit-${pkg.version}.tgz`);
  const bytes = await readFile(packed);
  const digest = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(output, 'lavish-kit.tgz'), bytes);
  await rm(packed);
  await writeFile(path.join(output, 'SHA256SUMS'), `${digest}  lavish-kit.tgz\n`);
  const npm = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  await writeFile(path.join(output, 'release-metadata.json'), JSON.stringify({ version: pkg.version, source, node: process.version, npm, sha256: digest }, null, 2) + '\n');
} finally { await rm(temp, { recursive: true, force: true }); }
