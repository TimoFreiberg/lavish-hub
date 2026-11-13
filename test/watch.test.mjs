import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, writeFile, chmod, rm, access, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode, decode } from '@toon-format/toon';
import { recordWatch, relayPaths, relayLog } from '../src/relay.mjs';
import { sessionOpen, watchLoop } from '../src/watch.mjs';
import { publishDocument } from '../src/document-page.mjs';
import { textHash } from '../src/save.mjs';
const exec = promisify(execFile);
const module = fileURLToPath(new URL('../src/relay.mjs', import.meta.url));
const until = async fn => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('worker watch timeout');
};
const exists = async file => { try { await access(file); return true; } catch { return false; } };

async function setup(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lavish-watch-'))), bin = path.join(dir, 'bin');
  await mkdir(bin);
  const file = path.join(dir, 'page.html'), listing = path.join(dir, 'sessions'), calls = path.join(dir, 'calls');
  await writeFile(file, '<title>Watch</title>');
  await writeFile(listing, encode({ sessions: [{ file, status: 'open' }] }));
  await writeFile(path.join(bin, 'lavish-axi'), `#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(!args.length)console.log(fs.readFileSync(${JSON.stringify(listing)},'utf8'));else if(args[0]==='poll'){const timer=setInterval(()=>{if(fs.readFileSync(${JSON.stringify(listing)},'utf8').trim()===${JSON.stringify(encode({ sessions: [] }))}){clearInterval(timer);console.log('session:\\n  status: ended');}},20);}else if(args[0]==='reply'){}else throw Error('unexpected Lavish command');\n`);
  await chmod(path.join(bin, 'lavish-axi'), 0o755);
  await writeFile(relayPaths(file).target, JSON.stringify({ version: 1, page: file, title: 'Watch', terminal: 'scratch' }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: path.join(dir, 'state') };
  const launch = () => exec(process.execPath, ['--input-type=module', '-e', `import {ensureRelay} from ${JSON.stringify(module)};await ensureRelay(${JSON.stringify(file)});`], { env, timeout: 15000 });
  t.after(async () => {
    try { process.kill(Number(await readFile(path.join(relayPaths(file).lock, 'pid'))), 'SIGTERM'); } catch {}
    await until(async () => !await exists(relayPaths(file).lock));
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, file, listing, calls, launch, log: path.join(dir, 'state/lavish-kit', path.basename(relayLog(file))), end: () => writeFile(listing, encode({ sessions: [] })) };
}

test('session listing is non-consuming, validates output, and propagates failures', async () => {
  const calls = [], file = '/tmp/review.html';
  const run = async (name, args) => { calls.push([name, args]); return { stdout: encode({ sessions: [{ file, status: 'feedback' }] }) }; };
  assert.equal(await sessionOpen(file, run, decode), true);
  assert.deepEqual(calls, [['lavish-axi', []]]);
  assert.equal(await sessionOpen(file, async () => ({ stdout: encode({ sessions: [] }) }), decode), false);
  await assert.rejects(sessionOpen(file, async () => ({ stdout: 'not a listing' }), decode));
  await assert.rejects(sessionOpen(file, async () => { throw Error('unavailable'); }, decode), /unavailable/);
});

test('watch-only worker reuses its PID, watches task/PR/markdown sources, reloads source, and exits on end without polling', async t => {
  const x = await setup(t), source = path.join(x.dir, 'source.md'), other = path.join(x.dir, 'other.md');
  await writeFile(source, '# Initial\n'); await writeFile(other, '# Other\n');
  await recordWatch(x.file, { kind: 'document', source });
  await x.launch();
  const pid = await readFile(path.join(relayPaths(x.file).lock, 'pid'), 'utf8');
  await until(() => exists(path.join(x.dir, 'latest.js')));
  const initial = await readFile(path.join(x.dir, 'latest.js'), 'utf8');
  await writeFile(source, '# Updated task\n');
  await until(async () => await readFile(path.join(x.dir, 'latest.js'), 'utf8') !== initial);
  // PR pages use the same document publisher, with title/body validation in the browser.
  const beforePR = await readFile(path.join(x.dir, 'latest.js'), 'utf8');
  await writeFile(source, '# Updated PR title\n\nPR body\n');
  await until(async () => await readFile(path.join(x.dir, 'latest.js'), 'utf8') !== beforePR);
  await recordWatch(x.file, { kind: 'document', source: other }); await x.launch();
  assert.equal(await readFile(path.join(relayPaths(x.file).lock, 'pid'), 'utf8'), pid);
  await until(async () => { const latest = await readFile(path.join(x.dir, 'latest.js'), 'utf8'), hash = latest.match(/[a-f0-9]{64}/)[0]; return (await readFile(path.join(x.dir, `data-${hash}.js`), 'utf8')).includes('# Other'); });
  await recordWatch(x.file, { kind: 'markdown', source: other }); await x.launch();
  await until(async () => (await readFile(x.file, 'utf8')).includes('<h1 id="other"'));
  await writeFile(other, '# Markdown changed\n');
  await until(async () => (await readFile(x.file, 'utf8')).includes('Markdown changed'));
  await rm(relayPaths(x.file).watch);
  await until(async () => (await readFile(x.log, 'utf8')).includes('watch spec failed:'));
  await x.end(); await until(async () => !await exists(relayPaths(x.file).lock));
  assert.ok((await readFile(x.calls, 'utf8')).trim().split('\n').map(JSON.parse).every(args => args.length === 0), 'missing watch spec must not enable polling');
});

test('watch-only worker can acquire delivery on herdr reopen and preserves delivery on outside reopen', async t => {
  const x = await setup(t);
  await recordWatch(x.file, null); await x.launch();
  const pid = await readFile(path.join(relayPaths(x.file).lock, 'pid'), 'utf8');
  await until(() => exists(x.calls));
  await recordWatch(x.file, null, true); await x.launch();
  await until(async () => (await readFile(x.calls, 'utf8')).includes('poll'));
  await recordWatch(x.file, null, false);
  assert.equal(JSON.parse(await readFile(relayPaths(x.file).watch)).delivery, true);
  assert.equal(await readFile(path.join(relayPaths(x.file).lock, 'pid'), 'utf8'), pid);
  await x.end(); await until(async () => !await exists(relayPaths(x.file).lock));
});

test('watch failures and session-listing failures are logged and retried', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lavish-watch-retry-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.md'), file = path.join(dir, 'page.html'), logs = [];
  const controller = new AbortController(); let ticks = 0, checks = 0;
  await watchLoop(file, {
    readSpec: async () => ({ delivery: false, watch: { kind: 'document', source } }), deps: {}, decode,
    run: async () => { if (!checks++) throw Error('temporary status failure'); return { stdout: encode({ sessions: [{ file, status: 'open' }] }) }; },
    log: text => logs.push(text), signal: controller.signal,
    sleep: async () => { if (++ticks === 2) await writeFile(source, '# Recovered\n'); if (ticks === 3) controller.abort(); },
  });
  assert.ok(logs.some(text => text.includes('temporary status failure')));
  assert.ok(logs.some(text => text.includes('ENOENT')));
  assert.ok(await exists(path.join(dir, 'latest.js')));
});

test('a changed spec republishes after an old in-flight publication', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lavish-watch-reopen-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'old.md'), other = path.join(dir, 'new.md'), file = path.join(dir, 'page.html');
  await writeFile(source, '# Old\n'); await writeFile(other, '# New\n');
  const hash = await publishDocument(file, source), controller = new AbortController();
  let current = { delivery: true, watch: { kind: 'document', source, hash } }, ticks = 0;
  await watchLoop(file, { deps: {}, readSpec: async () => current, delivery: () => true, signal: controller.signal,
    sleep: async () => {
      if (!ticks++) {
        await publishDocument(file, other);
        current = { delivery: true, watch: { kind: 'document', source: other, hash: textHash('# New\n') } };
        await publishDocument(file, source); // simulate the previous tick finishing late
      } else controller.abort();
    },
  });
  assert.ok((await readFile(path.join(dir, 'latest.js'), 'utf8')).includes(textHash('# New\n')));
});

test('watch-only worker picks up changed diff ranges without rewriting the shell', async t => {
  const x = await setup(t), repo = path.join(x.dir, 'repo'); await mkdir(repo);
  const git = args => exec('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } });
  await git(['init', '-q', '-b', 'main']);
  await writeFile(path.join(repo, 'x'), 'one\n'); await git(['add', 'x']); await git(['commit', '-qm', 'First']);
  await writeFile(path.join(repo, 'x'), 'two\n'); await git(['commit', '-am', 'Second']);
  await writeFile(path.join(repo, 'x'), 'three\n');
  const source = { kind: 'git', root: repo, diffArgs: ['HEAD'], range: 'working', rangeSource: 'test', rangeSpec: 'working', logRange: 'HEAD..HEAD' };
  await recordWatch(x.file, { kind: 'diff', source }); await x.launch();
  await until(() => exists(path.join(x.dir, 'latest.js')));
  const initial = await readFile(path.join(x.dir, 'latest.js'), 'utf8'), mtime = (await stat(x.file)).mtimeMs;
  const pid = await readFile(path.join(relayPaths(x.file).lock, 'pid'), 'utf8');
  await recordWatch(x.file, { kind: 'diff', source: { ...source, diffArgs: ['missing-revision'] } });
  await until(async () => (await readFile(x.log, 'utf8')).includes('watch failed: git:'));
  assert.equal(await readFile(path.join(relayPaths(x.file).lock, 'pid'), 'utf8'), pid, 'watch error must not kill worker');
  await recordWatch(x.file, { kind: 'diff', source: { ...source, diffArgs: ['HEAD~1', 'HEAD'], range: 'committed', rangeSpec: 'committed' } }); await x.launch();
  await until(async () => await readFile(path.join(x.dir, 'latest.js'), 'utf8') !== initial);
  const hash = (await readFile(path.join(x.dir, 'latest.js'), 'utf8')).match(/[a-f0-9]{64}/)[0];
  const data = await readFile(path.join(x.dir, `data-${hash}.js`), 'utf8');
  assert.ok(data.includes('committed')); assert.ok(data.includes('+two')); assert.ok(!data.includes('+three'));
  assert.equal((await stat(x.file)).mtimeMs, mtime);
  assert.equal(await readFile(path.join(relayPaths(x.file).lock, 'pid'), 'utf8'), pid);
  await x.end(); await until(async () => !await exists(relayPaths(x.file).lock));
});
