// Fixture executables model the CLI; real HTTP contracts have a separate suite.
process.env.LAVISH_KIT_LAVISH_TRANSPORT = 'cli';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, chmod, symlink, access, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimLock, recordWatch, relayPaths, withPublication } from '../src/relay.mjs';
import { watchLoop } from '../src/watch.mjs';
import { ensureDeps } from '../src/deps.mjs';

const cli = fileURLToPath(new URL('../bin/lavish-kit', import.meta.url));
const shared = await mkdtemp(path.join(os.tmpdir(), 'lavish-cli-cache-'));
const setupBin = path.join(shared, 'bin'); await mkdir(setupBin);
const npm = path.join(setupBin, 'npm'); await writeFile(npm, '#!/bin/sh\nln -s "$FIXTURE" node_modules\n'); await chmod(npm, 0o755);
const depsModule = fileURLToPath(new URL('../src/deps.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('../node_modules', import.meta.url));
const init = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(depsModule)}).then(m=>m.ensureDeps())`], { env: { ...process.env, XDG_DATA_HOME: shared, PATH: `${setupBin}:/usr/bin:/bin`, FIXTURE: fixture }, encoding: 'utf8' });
assert.equal(init.status, 0, init.stderr);
test.after(() => rm(shared, { recursive: true, force: true }));
async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lavish-cli-')), cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    async function locks(root) {
      let entries;
      try { entries = await readdir(root, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const found = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const child = path.join(root, entry.name);
        if (entry.name.endsWith('.relay.lock')) found.push(child);
        else found.push(...await locks(child));
      }
      return found;
    }
    for (const lock of await locks(dir)) {
      const page = lock.slice(0, -'.relay.lock'.length);
      await rm(page, { force: true });
      await rm(relayPaths(page).watch, { force: true });
      await rm(relayPaths(page).target, { force: true });
      await until(async () => !await exists(lock));
    }
    await rm(dir, { recursive: true, force: true });
  });
  const bin = path.join(dir, 'bin'); await mkdir(bin);
  const fake = async (name, body) => { const p = path.join(bin, name); const prefix = name === 'lavish-axi' ? 'if [ "$#" = 0 ]; then printf "sessions[0]:\\n"; exit; fi\nif [ "$1" = poll ]; then printf "session:\\n  status: ended\\n"; exit; fi\n' : ''; await writeFile(p, `#!/bin/sh\n${prefix}${body}\n`); await chmod(p, 0o755); };
  await fake('herdr-app', 'exit 1');
  await fake('hc', 'if [ "$1" = get ]; then printf \'{"address":"%s","state":"live","labels":{}}\\n\' "$2"; else printf \'[]\\n\'; fi');
  await fake('lavish-axi', 'printf "  url: http://localhost:123/review\\n"');
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, XDG_DATA_HOME: shared, XDG_STATE_HOME: path.join(dir, 'state'), LAVISH_AXI_STATE_DIR: path.join(dir, 'lavish'), HC_TERMINAL_ID: '', LOG: path.join(dir, 'log') };
  const run = (args, extra = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8' });
  const file = path.join(dir, 'page.html'); await writeFile(file, '<title>Page title</title>');
  const fakeJS = async (name, body) => { const p = path.join(bin, name); await writeFile(p, `#!${process.execPath}\n${body}\n`); await chmod(p, 0o755); };
  return { dir, bin, fake, fakeJS, run, file, env, cleanups };
}

const acknowledge = `const fs = require('node:fs');
const payload = JSON.parse(process.argv[3].slice('task-tree.artifact:'.length));
fs.writeFileSync(payload.ack, JSON.stringify({ok:true}));`;
async function assertRegistration(log, expected) {
  const [command, artifact] = (await readFile(log, 'utf8')).trim().split('\n'); assert.equal(command, 'do');
  const { ack, ...payload } = JSON.parse(artifact.slice('task-tree.artifact:'.length));
  assert.deepEqual(payload, expected);
  assert.equal(path.dirname(path.dirname(ack)), os.tmpdir());
  assert.match(path.basename(path.dirname(ack)), /^lavish-artifact-[A-Za-z0-9]{6}$/);
  assert.equal(path.basename(ack), 'ack.json');
  await assert.rejects(access(path.dirname(ack)), 'the acknowledgement directory is removed');
  return ack;
}
async function until(fn) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error('condition timed out');
}
const exists = async file => { try { await access(file); return true; } catch { return false; } };
function launch(x, args, extra = {}, nodeArgs = []) {
  const child = spawn(process.execPath, [...nodeArgs, cli, ...args], { cwd: x.dir, env: { ...x.env, ...extra } });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', status => resolve({ status, stdout, stderr })); });
  return { child, done };
}

test('a custom --out reopen waits for an old tick already rendering and publishes the new source', { timeout: 20000 }, async t => {
  const x = await setup(t), old = path.join(x.dir, 'old.md'), next = path.join(x.dir, 'new.md');
  await writeFile(old, '# Old source\n'); await writeFile(next, '# New source\n');
  await recordWatch(x.file, { kind: 'markdown', source: old });
  const started = path.join(x.dir, 'render-started'), gate = path.join(x.dir, 'render-release');
  const wrapper = path.join(x.dir, 'markdown.mjs'), attempt = path.join(x.dir, 'publication-attempt'), preload = path.join(x.dir, 'preload.mjs');
  const deps = await ensureDeps({ cache: path.join(shared, 'lavish-kit') });
  await writeFile(wrapper, `import MarkdownIt from ${JSON.stringify(deps.resolve('markdown-it'))};import {access,writeFile} from 'node:fs/promises';await writeFile(${JSON.stringify(started)},'started');while(true){try{await access(${JSON.stringify(gate)});break;}catch{await new Promise(resolve=>setTimeout(resolve,20));}}export default MarkdownIt;`);
  await writeFile(preload, `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';const mkdir=fs.mkdir;fs.mkdir=async(file,...args)=>{if(String(file).endsWith('.publication.lock'))await fs.writeFile(${JSON.stringify(attempt)},String(file));return mkdir(file,...args);};syncBuiltinESMExports();`);
  const controller = new AbortController();
  const loop = watchLoop(x.file, { readSpec: async () => JSON.parse(await readFile(relayPaths(x.file).watch)),
    deps: { ...deps, resolve: name => name === 'markdown-it' ? wrapper : deps.resolve(name) }, delivery: () => true,
    signal: controller.signal, publish: fn => withPublication(x.file, fn), sleep: async () => controller.abort(),
  });
  let command, stopping;
  const stop = () => stopping ??= (async () => {
    await writeFile(gate, 'release'); controller.abort();
    if (command) command.child.kill();
    await loop;
    if (command) await command.done;
  })();
  x.cleanups.push(stop);
  try {
    await until(() => exists(started));
    command = launch(x, [next, '--out', x.file], {}, ['--import', preload]);
    await until(() => exists(attempt));
    const locked = await readFile(attempt, 'utf8');
    if (locked !== `${x.file}.publication.lock`) await command.done;
    await writeFile(gate, 'release'); await loop;
    const result = await command.done; assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(x.file, 'utf8'), /<title>New source<\/title>/);
    assert.equal(locked, `${x.file}.publication.lock`);
    assert.equal(JSON.parse(await readFile(relayPaths(x.file).watch)).watch.source, await (await import('node:fs/promises')).realpath(next));
  } finally { await stop(); }
});

test('publication stays unlocked during target state wait and external opening commands', { timeout: 20000 }, async t => {
  const x = await setup(t), entered = path.join(x.dir, 'target-entered');
  const check = `const fs=require('node:fs');if(fs.existsSync(${JSON.stringify(`${x.file}.publication.lock`)}))throw Error('publication lock held');`;
  await x.fakeJS('lavish-axi', `${check}console.log(process.argv.length===2?'sessions[0]:':process.argv[2]==='poll'?'session:\\n  status: ended':'url: http://localhost:123/review');`);
  await x.fakeJS('hc', `${check}fs.writeFileSync(${JSON.stringify(entered)},'entered');console.log(JSON.stringify({address:'terminal',state:'live',labels:{}}));`);
  await x.fakeJS('herdr-app', `${check}${acknowledge.replace("const fs = require('node:fs');", '')}`);
  await x.fakeJS(process.platform === 'darwin' ? 'open' : 'xdg-open', check);
  const release = await claimLock(relayPaths(x.file).stateLock);
  const command = launch(x, [x.file, '--open'], { HC_TERMINAL_ID: 'terminal' });
  try {
    await until(() => exists(entered));
    await withPublication(x.file, async () => { assert.equal(JSON.parse(await readFile(relayPaths(x.file).watch)).watch, null); });
  } finally { await release(); }
  const result = await command.done; assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /listed under the task's Artifacts/);
  const browser = path.join(x.dir, 'browser-opened');
  await x.fakeJS('herdr-app', `${check}process.exit(1);`);
  await x.fakeJS(process.platform === 'darwin' ? 'open' : 'xdg-open', `${check}fs.writeFileSync(${JSON.stringify(browser)},'opened');`);
  const fallback = x.run([x.file, '--open'], { HC_TERMINAL_ID: 'terminal' });
  assert.equal(fallback.status, 0, fallback.stderr); assert.equal(await readFile(browser, 'utf8'), 'opened');
});

test('registers html with title and title override', async t => {
  const x = await setup(t); await x.fakeJS('herdr-app', `${acknowledge}\nfs.writeFileSync(process.env.LOG, process.argv.slice(2).join('\\n'));`);
  for (const [args, title] of [[[x.file], 'Page title'], [[x.file, '--title', 'Override'], 'Override']]) {
    const r = x.run(args, { HC_TERMINAL_ID: 'terminal' }); assert.equal(r.status, 0); assert.equal(r.stdout, `Lavish review of ${x.file} is listed under the task's Artifacts.\nFeedback is delivered automatically; do not poll ${x.file}.\n`); assert.equal(r.stderr, '');
    await assertRegistration(x.env.LOG, { terminal: 'terminal', path: x.file, title });
  }
});
test('fallbacks are silent on stderr', async t => {
  const x = await setup(t);
  for (const [terminal, script] of [['', null], ['t', null], ['t', 'echo need the mod loaded >&2; exit 1']]) {
    if (script) await x.fake('herdr-app', script);
    const r = x.run([x.file], { HC_TERMINAL_ID: terminal }); assert.equal(r.status, 0); assert.match(r.stdout, /^Lavish review of .+page\.html ready: http:\/\/localhost:123\/review\S* \(ask the user to open it\)\nFeedback (is delivered automatically|requires agent polling):?/);
    assert.match(r.stdout, terminal ? /Feedback is delivered automatically; do not poll/ : /Feedback requires agent polling: lavish-axi poll/); assert.equal(r.stderr, '');
    if (terminal) assert.equal(JSON.parse(await readFile(`${x.file}.relay.json`)).terminal, terminal, 'target is recorded even without registration');
    else await assert.rejects(access(`${x.file}.relay.json`), 'outside herdr there is no relay sidecar');
  }
});
test('printed poll command preserves shell metacharacters literally', async t => {
  const x = await setup(t), file = path.join(x.dir, "a $HOME $(touch injected) `touch backtick` ' page.html");
  await writeFile(file, '<title>Literal</title>');
  const result = x.run([file]); assert.equal(result.status, 0, result.stderr);
  const command = result.stdout.match(/Feedback requires agent polling: (.*)\.\n/)[1];
  await x.fakeJS('lavish-axi', `console.log(JSON.stringify(process.argv.slice(2)));`);
  const polled = spawnSync('/bin/sh', ['-c', command], { cwd: x.dir, env: x.env, encoding: 'utf8' });
  assert.equal(polled.status, 0, polled.stderr); assert.deepEqual(JSON.parse(polled.stdout), ['poll', file]);
  await assert.rejects(access(path.join(x.dir, 'injected'))); await assert.rejects(access(path.join(x.dir, 'backtick')));
});

test('bad input, lavish failure, and no shell interpolation', async t => {
  const x = await setup(t);
  for (const [args, message] of [[[], /^usage:/], [['missing.html'], /missing\.html: no such file/], [[x.file, '--bad'], /unknown argument --bad/], [['bad.txt'], /expected a \.html, \.md, or \.markdown file/], [[x.file, '--title'], /--title requires a value/]]) {
    const r = x.run(args); assert.equal(r.status, 2); assert.match(r.stderr, message); assert.match(r.stderr, /lavish-kit --help/);
  }
  await x.fake('lavish-axi', 'echo broken >&2; exit 1'); let r = x.run([x.file]); assert.equal(r.status, 1); assert.match(r.stderr, /broken/);
  await x.fake('lavish-axi', 'echo nothing'); r = x.run([x.file]); assert.equal(r.status, 1);
  await x.fake('lavish-axi', 'printf "url: http://localhost:123/review\\n"');
  const hostile = path.join(x.dir, '$(touch pwned); page.html'); await writeFile(hostile, '<title>x</title>');
  assert.equal(x.run([hostile]).status, 0); await assert.rejects(access(path.join(x.dir, 'pwned')));
  await x.fakeJS('herdr-app', `${acknowledge}\nfs.writeFileSync(process.env.LOG, process.argv.slice(2).join('\\n'));`);
  const title = '$(touch title-pwned); "quoted"';
  r = x.run([hostile, '--title', title], { HC_TERMINAL_ID:'terminal' }); assert.equal(r.status, 0, r.stderr);
  await assertRegistration(x.env.LOG, {terminal:'terminal',path:hostile,title});
  await assert.rejects(access(path.join(x.dir, 'pwned'))); await assert.rejects(access(path.join(x.dir, 'title-pwned')));
});
test('user-ended review does not register or open, and --reopen is forwarded', async t => {
  const x = await setup(t); await x.fake('herdr-app', 'touch "$LOG"');
  await x.fake(process.platform === 'darwin' ? 'open' : 'xdg-open', 'touch "$LOG"');
  await x.fake('lavish-axi', 'printf "status: user-ended\\nurl: http://localhost:123/review\\n"');
  let r = x.run([x.file, '--open'], { HC_TERMINAL_ID: 't' }); assert.equal(r.status, 0); assert.match(r.stdout, /--reopen/); await assert.rejects(access(x.env.LOG));
  await x.fake('lavish-axi', 'printf "%s\\n" "$@" > "$LOG"; printf "url: http://localhost:123/review\\n"');
  r = x.run([x.file, '--reopen']); assert.equal(r.status, 0); const args = await readFile(x.env.LOG, 'utf8'); assert.match(args, /--reopen/); assert.match(args, /--no-open/);
});
test('prepares once and opens the browser only when requested and registration fails', async t => {
  for (const [terminal, succeeds, open, reopen] of [['t', true, true, true], ['t', true, false, false], ['t', false, true, true], ['', false, true, false], ['t', false, false, false], ['', false, false, false]]) {
    const x = await setup(t);
    await x.fake('lavish-axi', 'printf "lavish" >> "$LOG"; printf " <%s>" "$@" >> "$LOG"; printf "\\n" >> "$LOG"; printf "url: http://localhost:123/review\\n"');
    await x.fakeJS('herdr-app', succeeds ? `${acknowledge}\nfs.appendFileSync(process.env.LOG, 'register\\n');` : `require('node:fs').appendFileSync(process.env.LOG, 'register\\n'); process.exit(1);`);
    await x.fake(process.platform === 'darwin' ? 'open' : 'xdg-open', 'printf "browser <%s>\\n" "$1" >> "$LOG"');
    const r = x.run([x.file, ...(open ? ['--open'] : []), ...(reopen ? ['--reopen'] : [])], { HC_TERMINAL_ID: terminal });
    assert.equal(r.status, 0, r.stderr);
    const lines = (await readFile(x.env.LOG, 'utf8')).trim().split('\n');
    assert.deepEqual(lines, [`lavish <${x.file}> <--no-open>${reopen ? ' <--reopen>' : ''}`, ...(terminal ? ['register'] : []), ...(open && !succeeds ? ['browser <http://localhost:123/review>'] : [])]);
    assert.match(r.stdout, succeeds ? /listed under the task's Artifacts/ : /ready: http:\/\/localhost:123\/review/);
  }
});
test('exit zero without acknowledgement is not registration and falls back only with --open', async t => {
  const x = await setup(t);
  await x.fakeJS('herdr-app', `require('node:fs').writeFileSync(process.env.LOG, process.argv.slice(2).join('\\n')); console.log('{"ok":true}');`);
  const browserLog = path.join(x.dir, 'browser');
  await x.fake(process.platform === 'darwin' ? 'open' : 'xdg-open', 'printf "%s\\n" "$1" >> "$BROWSER_LOG"');
  for (const open of [false, true]) {
    const start = Date.now();
    const r = x.run([x.file, ...(open ? ['--open'] : [])], { HC_TERMINAL_ID:'unknown', BROWSER_LOG:browserLog });
    assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, ''); assert.match(r.stdout, /ready: http:\/\/localhost:123\/review/);
    assert.ok(Date.now() - start < 4000, 'registration wait is bounded');
    await assertRegistration(x.env.LOG, { terminal:'unknown', path:x.file, title:'Page title' });
    if (open) assert.equal(await readFile(browserLog, 'utf8'), 'http://localhost:123/review\n');
    else await assert.rejects(access(browserLog));
  }
});
test('waits for acknowledgement after the queue command exits', async t => {
  const x = await setup(t);
  await x.fakeJS('herdr-app', `const fs = require('node:fs');
const payload = JSON.parse(process.argv[3].slice('task-tree.artifact:'.length));
if (fs.readFileSync(payload.ack, 'utf8') !== JSON.stringify({pending:true})) process.exit(1);
fs.writeFileSync(process.env.LOG, process.argv.slice(2).join('\\n'));
require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ok:true})), 100)', payload.ack], {detached:true,stdio:'ignore'}).unref();`);
  const r = x.run([x.file], {HC_TERMINAL_ID:'terminal'});
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /listed under the task's Artifacts/);
  await assertRegistration(x.env.LOG, {terminal:'terminal',path:x.file,title:'Page title'});
});
test('registration rejection and hung queue commands clean up and remain optional', async t => {
  const x = await setup(t);
  for (const failure of ['rejected', 'negative', 'hung']) {
    await x.fakeJS('herdr-app', `const fs = require('node:fs');
fs.writeFileSync(process.env.LOG, process.argv.slice(2).join('\\n'));
const payload = JSON.parse(process.argv[3].slice('task-tree.artifact:'.length));
${failure === 'rejected' ? 'process.exit(1);' : failure === 'negative' ? 'fs.writeFileSync(payload.ack, JSON.stringify({ok:false}));' : 'setInterval(() => {}, 1000);'}`);
    const start = Date.now(), r = x.run([x.file], { HC_TERMINAL_ID:'terminal' });
    assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, ''); assert.match(r.stdout, /ready:/);
    assert.ok(Date.now() - start < 4000, 'submission and acknowledgement share a bounded wait');
    await assertRegistration(x.env.LOG, {terminal:'terminal',path:x.file,title:'Page title'});
  }
});
test('reports browser opener failure', async t => {
  const x = await setup(t); await x.fake(process.platform === 'darwin' ? 'open' : 'xdg-open', 'echo cannot-open >&2; exit 1');
  const r = x.run([x.file, '--open']); assert.equal(r.status, 1); assert.match(r.stderr, /cannot-open/);
});
test('first-use npm failure is reported and leaves no partial cache', async t => {
  const x = await setup(t); await x.fake('npm', 'echo network-broke >&2; exit 1');
  const data = path.join(x.dir, 'data'); const r = x.run([x.file], { XDG_DATA_HOME: data });
  assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.match(r.stderr, /network-broke/); assert.match(r.stderr, /needs npm and network access; fix that and rerun the same lavish-kit command/);
  assert.deepEqual(await readdir(path.join(data, 'lavish-kit', 'deps')), []);
});
test('executable works through a deployed symlink', async t => {
  const x = await setup(t); const link = path.join(x.bin, 'lavish-kit'); await symlink(cli, link);
  const r = spawnSync(link, [x.file], { cwd: x.dir, env: { ...x.env, PATH: `${x.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /http:\/\/localhost:123\/review/);
});
test('git command returns promptly while its watch-only worker updates data', async t => {
  const x = await setup(t); const repo=path.join(x.dir,'repo'); await mkdir(repo);
  assert.equal(spawnSync('git',['init','-q','-b','main',repo]).status,0);
  const env={...x.env,GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.invalid'};
  await writeFile(path.join(repo,'x'),'one\n'); assert.equal(spawnSync('git',['add','x'],{cwd:repo,env}).status,0); assert.equal(spawnSync('git',['commit','-qm','first'],{cwd:repo,env}).status,0);
  await writeFile(path.join(repo,'x'),'two\n'); const out=path.join(await (await import('node:fs/promises')).realpath(x.dir),'out','index.html'), ended=path.join(x.dir,'ended');
  await x.fakeJS('lavish-axi', `const fs=require('node:fs'); const args=process.argv.slice(2); if(!args.length) console.log(fs.existsSync(${JSON.stringify(ended)}) ? 'sessions[0]:' : 'sessions[1]{file,status}:\\n  '+JSON.stringify(${JSON.stringify(out)})+',open'); else if(args[0]==='poll') { fs.writeFileSync(${JSON.stringify(path.join(x.dir,'unexpected-poll'))},'poll'); process.exit(1); } else console.log('url: http://localhost:123/review');`);
  const until=async fn=>{ const deadline=Date.now()+15000; while(Date.now()<deadline) { if(await fn()) return; await new Promise(resolve=>setTimeout(resolve,100)); } throw new Error('watch timeout'); };
  x.cleanups.push(async()=>{ await writeFile(ended,'end'); await until(async()=>{try{await access(`${out}.relay.lock`);return false;}catch{return true;}}); });
  const start=Date.now(), r=spawnSync(process.execPath,[cli,'diff','--git','--out',out],{cwd:repo,env,encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr); assert.ok(Date.now()-start<10000,'command returns before review ends');
  const latest=path.join(path.dirname(out),'latest.js'), before=await readFile(latest,'utf8');
  const shellTime=(await import('node:fs/promises')).stat, mtime=(await shellTime(out)).mtimeMs;
  await writeFile(path.join(repo,'x'),'three\n'); await until(async()=>await readFile(latest,'utf8')!==before);
  assert.equal((await shellTime(out)).mtimeMs,mtime); assert.equal(r.stdout.trim().split('\n').length,2); assert.match(r.stdout, /Feedback requires agent polling/); assert.equal(r.stderr,'');
  await assert.rejects(access(path.join(x.dir,'unexpected-poll')));
});
test('diff argument errors name the conflicting or missing option', async t => {
  const x = await setup(t);
  for (const [args, message] of [[['diff','-r'], /-r requires/], [['diff','--repo-root','x'], /--repo-root requires/], [['diff','-','--watch'], /unknown argument --watch/], [['diff','-r','a','--from','b','--to','c'], /-r conflicts/]]) {
    const result=x.run(args); assert.equal(result.status,2); assert.match(result.stderr,message);
  }
});
test('output confinement precedes creating files for markdown and diff', async t => {
  const x = await setup(t); const repo = path.join(x.dir, 'repo'); await mkdir(repo);
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
  const md = path.join(repo, 'page.md'); await writeFile(md, '# test');
  const link = path.join(x.dir, 'link'); await symlink(repo, link);
  const sourceLink = path.join(x.dir, 'linked.md'); await symlink(md, sourceLink);
  const linkedResult = x.run([sourceLink, '--out', path.join(repo, 'new', 'index.html')]);
  assert.equal(linkedResult.status, 1); assert.match(linkedResult.stderr, /output inside/); await assert.rejects(access(path.join(repo, 'new')));
  for (const out of [path.join(repo, 'new', 'index.html'), path.join(link, 'new', 'index.html')]) {
    for (const args of [[md, '--out', out], ['diff', '--repo-root', repo, '-', '--out', out]]) {
      const r = x.run(args); assert.equal(r.status, 1); assert.match(r.stderr, /output inside/); await assert.rejects(access(path.join(repo, 'new')));
    }
  }
  const outsideTarget = path.join(x.dir, 'outside-target'); await writeFile(outsideTarget, 'untouched');
  const leaf = path.join(repo, 'leaf.html'); await symlink(outsideTarget, leaf);
  for (const args of [[md, '--out', leaf], ['diff', '--repo-root', repo, '-', '--out', leaf]]) {
    const r = x.run(args); assert.equal(r.status, 1); assert.match(r.stderr, /output inside/);
    assert.equal(await readFile(outsideTarget, 'utf8'), 'untouched');
    assert.equal(await (await import('node:fs/promises')).readlink(leaf), outsideTarget);
    await assert.rejects(access(path.join(repo, 'assets')));
  }
  const inward = path.join(x.dir, 'inward.html'); await symlink(md, inward);
  for (const args of [[md, '--out', inward], ['diff', '--repo-root', repo, '-', '--out', inward]]) {
    const r = x.run(args); assert.equal(r.status, 1); assert.match(r.stderr, /output inside/); assert.equal(await readFile(md, 'utf8'), '# test');
  }
  let r = x.run(['diff', '--repo-root', repo, '-'], { HOME: repo, XDG_DATA_HOME: '' });
  assert.equal(r.status, 1); assert.match(r.stderr, /output inside/); await assert.rejects(access(path.join(repo, '.local')));
  const out = path.join(x.dir, 'outside', 'index.html'); r = x.run([md, '--out', out]);
  assert.equal(r.status, 0, r.stderr); assert.match(await readFile(out, 'utf8'), /assets\/task-app\.js/);
  r = x.run([x.file, '--out', out]); assert.equal(r.status, 0); assert.equal(await readFile(out, 'utf8'), '<title>Page title</title>');
  r = x.run([md], { HOME: repo, XDG_DATA_HOME: '' }); assert.equal(r.status, 1); assert.match(r.stderr, /output inside/); await assert.rejects(access(path.join(repo, '.local')));
});
test('markdown title is registered and can be overridden', async t => {
  const x = await setup(t); await x.fakeJS('herdr-app', `${acknowledge}\nfs.writeFileSync(process.env.LOG, process.argv.slice(2).join('\\n'));`);
  const file = path.join(x.dir, 'doc.md'); await writeFile(file, '---\ntitle: "A & B"\n---\n# Heading');
  for (const [extra, title] of [[[], 'A & B'], [['--title', 'Override'], 'Override']]) {
    const out = path.join(x.dir, 'out.html');
    const r = x.run([file, '--out', out, ...extra], { HC_TERMINAL_ID: 'terminal' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /listed under the task's Artifacts/);
    await assertRegistration(x.env.LOG, { terminal: 'terminal', path: out, title });
  }
});
