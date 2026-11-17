import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { lstat, mkdtemp, mkdir, open, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const archive = path.resolve(process.argv[2] || 'lavish-kit.tgz');
const temp = await mkdtemp(path.join(os.tmpdir(), 'lavish-kit-smoke-'));
let owner;
try {
  const inventory = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.equal(inventory.status, 0, inventory.stderr);
  assert.doesNotMatch(inventory.stdout, /(?:^|\/)(?:\.git|\.jj|\.workspaces|\.checks|@esbuild|playwright-core)(?:\/|$)/m);
  const extract = spawnSync('tar', ['-xzf', archive, '-C', temp], { encoding: 'utf8' });
  assert.equal(extract.status, 0, extract.stderr);
  const root = path.join(temp, 'package'), cli = path.join(root, 'bin/lavish-kit');
  for (const file of ['vendor/lavish/dist/cli.mjs', 'vendor/lavish/dist/server.mjs', 'vendor/lavish/dist/design/daisyui.css', 'vendor/lavish/dist/whiteboard/whiteboard.js', 'vendor/lavish/dist/whiteboard/fonts/Excalifont', 'node_modules/express/package.json', 'dist/hub-markdown.js']) await readFile(path.join(root, file)).catch(async error => { if (error.code !== 'EISDIR') throw error; });
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  assert.deepEqual(Object.keys(pkg.bin), ['lavish-kit']);
  assert.ok(!pkg.scripts?.install && !pkg.scripts?.postinstall && !pkg.scripts?.prepare);
  const dependencies = spawnSync('npm', ['ls', '--omit=dev', '--all'], { cwd: root, encoding: 'utf8' });
  assert.equal(dependencies.status, 0, dependencies.stdout + dependencies.stderr);
  async function inspect(dir) {
    for (const entry of await readdir(dir)) {
      const file = path.join(dir, entry), info = await lstat(file);
      if (info.isSymbolicLink()) {
        const target = await readlink(file);
        assert.ok(!path.isAbsolute(target), `absolute symlink: ${file}`);
        const resolved = await realpath(file);
        assert.ok(resolved.startsWith(`${root}${path.sep}`), `external symlink: ${file}`);
      } else if (info.isDirectory()) await inspect(file);
      else if (info.isFile()) {
        assert.doesNotMatch(file, /\.node$/i, `native addon: ${file}`);
        const handle = await open(file, 'r');
        try {
          const magic = Buffer.alloc(4); await handle.read(magic, 0, 4, 0);
          const signature = magic.toString('hex');
          assert.ok(!['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(signature), `native binary: ${file}`);
        } finally { await handle.close(); }
      }
    }
  }
  await inspect(root);
  const provenance = JSON.parse(await readFile(path.join(root, 'provenance.json'), 'utf8'));
  assert.match(provenance.source, /^[0-9a-f]{40,64}$/);
  assert.equal(provenance.lavishVersion, '0.1.97');
  const readonly = spawnSync('chmod', ['-R', 'a-w', root], { encoding: 'utf8' });
  assert.equal(readonly.status, 0, readonly.stderr);
  const repo = path.join(temp, 'repo'), home = path.join(temp, 'home'), trap = path.join(temp, 'trap');
  await Promise.all([mkdir(repo), mkdir(home), mkdir(trap)]);
  await writeFile(path.join(trap, 'lavish-axi'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: path.join(home, 'state'), XDG_DATA_HOME: path.join(home, 'data'), LAVISH_AXI_STATE_DIR: path.join(home, 'state/lavish-kit/lavish'), LAVISH_AXI_PORT: String(port), PATH: `${trap}${path.delimiter}${process.env.PATH}` };
  const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(run(['--help']).status, 0);
  assert.equal(run(['diff']).status, 2);
  const init = spawnSync('jj', ['git', 'init'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  owner = spawn(process.execPath, [cli, 'hub', 'listen'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; owner.stderr.on('data', chunk => { logs += chunk; });
  let status;
  for (let i = 0; i < 100; i++) {
    if (owner.exitCode !== null) throw new Error(`owner exited: ${logs}`);
    status = run(['hub', 'status']);
    if (status.status === 0) break;
    await delay(100);
  }
  assert.equal(status.status, 0, logs + status.stderr);
  const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json());
  assert.equal(health.lavish_kit_page_reviews, 1);
  const file = path.join(temp, 'example.html');
  await writeFile(file, '<title>Example</title><link rel="stylesheet" href="example.css"><script src="example.js"></script><p>Hello</p>');
  await writeFile(path.join(temp, 'example.css'), 'p { color: red }');
  await writeFile(path.join(temp, 'example.js'), 'window.example = true;');
  const publish = run(['hub', 'publish', file, '--id', 'example']);
  assert.equal(publish.status, 0, publish.stderr);
  const { resolveWorkspace } = await import(pathToFileURL(path.join(root, 'src/hub-workspace.mjs')).href);
  const identity = await resolveWorkspace(repo, env);
  const runtime = JSON.parse(await readFile(path.join(identity.directory, 'owner/runtime.json'), 'utf8'));
  const url = logs.match(/ready: (https?:\/\/\S+)/)?.[1];
  assert.ok(url, logs);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/i);
  const generated = await readFile(runtime.page, 'utf8');
  const config = JSON.parse(generated.match(/globalThis\.hubConfig=(\{[^<]+?\});/)?.[1] || 'null');
  assert.ok(config?.resourceKey);
  for (const [name, expected] of [['example.css', 'color: red'], ['example.js', 'window.example']]) {
    const response = await fetch(`${config.url}/resources/${config.resourceKey}/example/${name}`);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes(expected));
  }
  const reply = run(['reply', runtime.page, '--agent-reply', 'Package smoke reply']);
  assert.equal(reply.status, 0, reply.stderr);
  assert.equal(run(['hub', 'stop']).status, 0);
  await new Promise((resolve, reject) => { if (owner.exitCode !== null) return resolve(); owner.once('exit', resolve); owner.once('error', reject); });
  assert.equal(owner.exitCode, 0);
  await assert.rejects(readFile(path.join(identity.directory, 'owner/runtime.json')), { code: 'ENOENT' });
  console.log('Package smoke passed');
} finally {
  if (owner && owner.exitCode === null) owner.kill('SIGTERM');
  spawnSync('chmod', ['-R', 'u+w', temp]);
  await rm(temp, { recursive: true, force: true });
}
