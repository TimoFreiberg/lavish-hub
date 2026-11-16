// Run with hc available: node test/relay-e2e.mjs
// This creates and cleans up only its own scratch terminals and Lavish page.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, chmod, readFile, writeFile, rm, access, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { relayPaths, relayLog } from '../src/relay.mjs';
import { ensureDeps } from '../src/deps.mjs';
import { cleanupTerminals } from './relay-e2e-cleanup.mjs';
const exec = promisify(execFile);
const cli = path.resolve(import.meta.dirname, '../bin/lavish-kit');
const session = `lavish-relay-e2e-${process.pid}`;
const dir = await mkdtemp(path.join(os.tmpdir(), 'lavish-relay-e2e-'));
const file = path.join(dir, 'page.html');
const sourceFile = path.join(dir, 'task.md');
const prFile = path.join(dir, 'pr-page/index.html'), prSource = path.join(dir, 'pr.md');
const launchFile = path.join(dir, 'launch.json'), captureFile = path.join(dir, 'create-pr.json');
const terminals = []; let browser;
const space = session, tab = `${session}-pr`, journal = path.join(dir, 'terminal.json');
const bin = path.join(dir, 'bin'), config = path.join(dir, 'config'), repo = path.join(dir, 'repo');
const stubFile = path.join(bin, 'create-pr-stub');
const executable = async (name, script) => { const file = path.join(bin, name); await writeFile(file, `#!${process.execPath}\n${script}\n`); await chmod(file, 0o755); };
const outsideFile = path.join(dir, 'markdown/index.html'), outsideSource = path.join(dir, 'notes.md');
const run = async (name, args, options = {}) => {
  const result = await exec(name, args, { ...options, maxBuffer: 4 * 1024 * 1024 });
  console.log(`$ ${name === process.execPath ? 'node' : name} ${args.join(' ')}`);
  return result.stdout;
};
const until = async fn => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('E2E readiness timeout');
};
let primaryError;
try {
  // Dependency installation and bundling are not part of the prompt-return check.
  await ensureDeps();
  await mkdir(bin); await mkdir(path.join(config, 'lavish-kit'), { recursive: true });
  await executable('create-pr-stub', `const fs=require('node:fs'); const args=process.argv.slice(2); const source=args[args.indexOf('--body-file')+1]; fs.writeFileSync(${JSON.stringify(captureFile)},JSON.stringify({args,cwd:process.cwd(),terminal:process.env.HC_TERMINAL_ID,text:fs.readFileSync(source,'utf8')})); console.log('stub-create-pr: '+JSON.stringify(args)); console.log('No GitHub access');`);
  await executable('herdr-app', `const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict');
const args=process.argv.slice(2);
if(args[0]==='do' && args[1]?.startsWith('task-tree.artifact:')) { const payload=JSON.parse(args[1].slice('task-tree.artifact:'.length)); fs.writeFileSync(payload.ack,JSON.stringify({ok:true})); process.exit(0); }
assert.deepEqual(args.slice(0,2),['do','tab.new']); assert.equal(args.length,3);
const request=JSON.parse(args[2]), source=fs.realpathSync(${JSON.stringify(prSource)}), repo=fs.realpathSync(${JSON.stringify(repo)});
assert.deepEqual(request,{space:${JSON.stringify(space)},folder:repo,name:'Create PR',argv:[${JSON.stringify(process.execPath)},${JSON.stringify(stubFile)},'-r','@-','--body-file',source]});
assert.equal(fs.readFileSync(source,'utf8'),${JSON.stringify('# Create PR title\n\nCreate PR body " \\ 雪\n\n')});
assert.ok(JSON.parse(fs.readFileSync(${JSON.stringify(relayPaths(prFile).outbox)},'utf8')).some(batch=>batch.states.some(state=>state.launchAttempted)));
const result=JSON.parse(cp.execFileSync('hc',['run','--bg','--no-parent','--no-notify','--json','--cwd',repo,'--label',${JSON.stringify(`herdr.space=${space}`)},'--label',${JSON.stringify(`herdr.tab=${tab}`)},${JSON.stringify(process.execPath)},${JSON.stringify(stubFile)},'-r','@-','--body-file',source],{encoding:'utf8'}));
fs.writeFileSync(${JSON.stringify(journal)},JSON.stringify(result.address)); assert.ok(result.address);
const launch={space:${JSON.stringify(space)},tab:${JSON.stringify(tab)},terminal:result.address}; fs.writeFileSync(${JSON.stringify(launchFile)},JSON.stringify(launch)); process.stdout.write(JSON.stringify(launch));`);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.LAVISH_AXI_STATE_DIR = path.join(dir, 'lavish-state');
  process.env.LAVISH_KIT_LAVISH_TRANSPORT = 'cli';
  for (const label of [session, `${session}-spare`]) {
    const result = JSON.parse(await run('hc', ['run', '--bg', '--no-parent', '--no-notify', '--json', '--cwd', dir, '--label', `herdr.space=${space}`, '--label', `polytoken.session=${label}`, 'cat']));
    const terminal = result.address;
    assert.ok(terminal, JSON.stringify(result));
    terminals.push(terminal); console.log(`Created scratch terminal ${terminal} in ${space}`);
  }
  await writeFile(sourceFile, '# Relay E2E\n\nQuoted E2E context\n');
  const taskStart = Date.now();
  const taskOutput = await run(process.execPath, [cli, sourceFile, '--out', file, '--title', 'Relay E2E'], { env: { ...process.env, HC_TERMINAL_ID: terminals[0] }, timeout: 15000 });
  assert.match(taskOutput, /Lavish review/); assert.ok(Date.now() - taskStart < 15000);
  console.log('PASS: task command returned promptly before feedback and disk updates.');
  assert.equal(JSON.parse(await readFile(relayPaths(file).target)).sourceFile, await realpath(sourceFile));
  // Querying open's URL does not create a second poll listener.
  const opened = await run('lavish-axi', [file, '--no-open']);
  const url = opened.match(/url:\s*"?(https?:\/\/[^"\s]+)/)?.[1]; assert.ok(url);
  browser = await chromium.launch({ executablePath: process.env.LAVISH_KIT_CHROMIUM || chromium.executablePath(), headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => console.log(`Browser error: ${error.message}`));
  page.on('response', response => { if (response.request().method() === 'POST') console.log(`Browser POST ${new URL(response.url()).pathname}: ${response.status()}`); });
  await page.goto(url);
  const frame = page.frames().find(frame => frame !== page.mainFrame()); assert.ok(frame);
  await frame.waitForFunction(() => typeof window.lavish?.sendQueuedPrompts === 'function');
  for (const [index, text] of [[0, 'relay-e2e-first-comment'], [1, 'relay-e2e-moved-comment']]) {
    if (index) {
      await run('hc', ['label', terminals[0], `polytoken.session=${session}-retired`]);
      await run('hc', ['label', terminals[1], `polytoken.session=${session}`]);
    }
    await frame.evaluate(text => {
      window.lavish.queuePrompt(text, { tag: 'code-comment', text: 'Quoted E2E context', target: { path: 'example.md', line: 1 } });
      window.lavish.sendQueuedPrompts();
    }, text);
    let screen;
    try { await until(async () => { screen = (await exec('hc', ['read', terminals[index]])).stdout; return screen.includes(text); }); }
    catch (error) { console.log(`Conversation on failure:\n${await page.locator('body').innerText()}\nTerminal screen:\n${screen}`); throw error; }
    assert.match(screen, /Quoted E2E context/); assert.match(screen, /do not poll this page/);
    console.log(`hc read ${terminals[index]} confirmed ${text}:\n${screen.trim()}`);
    if (index) assert.ok(!(await exec('hc', ['read', terminals[0]])).stdout.includes(text), 'moved delivery must not reach the old terminal');
  }
  const editor = frame.getByRole('textbox', { name: 'Markdown text' });
  await frame.getByRole('status').filter({ hasText: 'up to date with disk' }).waitFor();
  await frame.getByRole('button', { name: 'Edit', exact: true }).click();
  await until(async () => (await editor.inputValue()).includes('Quoted E2E context'));
  const saved = '# Saved from task page\n\n' + ('Odd " \\ Context data: </script> 雪 🦊\u2028\n').repeat(20000);
  await editor.fill('# Saved from task page\n');
  await editor.evaluate((node, value) => { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); }, saved);
  await frame.getByRole('button', { name: 'Send', exact: true }).click();
  await until(async () => await readFile(sourceFile, 'utf8') === saved);
  let notice;
  await until(async () => { notice = (await exec('hc', ['read', terminals[1]])).stdout; return notice.includes('The user edited') && notice.includes(sourceFile); });
  assert.ok(!notice.includes('Odd "'), 'full save contents must not reach the agent');
  await until(async () => (await frame.getByRole('status').innerText()).includes('up to date with disk'));
  assert.equal(await editor.inputValue(), saved);
  console.log(`PASS: page Send wrote ${Buffer.byteLength(saved)} UTF-8 bytes exactly; watched page updated without reload.`);
  console.log(`hc read ${terminals[1]} confirmed short save notice:\n${notice.trim()}`);
  await run('lavish-axi', ['end', file]);
  await until(async () => { try { await access(relayPaths(file).lock); return false; } catch { return true; } });
  console.log('PASS: browser queue-and-send, delivery, moved session, and relay exit');

  // The mock validates tab.new and launches only the configured scratch stub via hc.
  await writeFile(path.join(config, 'lavish-kit/config.json'), JSON.stringify({ createPr: [process.execPath, stubFile] }));
  await run('jj', ['git', 'init', repo]);
  for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.invalid'], ['revset-aliases."trunk()"', 'root()']]) {
    await run('jj', ['config', 'set', '--repo', key, value], { cwd: repo });
  }
  await writeFile(path.join(repo, 'fixture.txt'), 'E2E fixture\n');
  await run('jj', ['commit', '-m', 'Create E2E fixture'], { cwd: repo });
  await writeFile(prSource, '# PR E2E title\n\nInitial PR body\n');
  const prStart = Date.now();
  const prOutput = await run(process.execPath, [cli, 'pr', prSource, '-r', '@-', '--out', prFile], { cwd: repo, env: { ...process.env, HC_TERMINAL_ID: terminals[1], XDG_CONFIG_HOME: config }, timeout: 15000 });
  assert.match(prOutput, /Lavish review/); assert.ok(Date.now() - prStart < 15000);
  console.log('PASS: PR command returned promptly before Send/Create PR.');
  const prTarget = JSON.parse(await readFile(relayPaths(prFile).target));
  assert.equal(prTarget.pr.repo, await realpath(repo)); assert.equal(prTarget.pr.rev, '@-');
  const prOpened = await run('lavish-axi', [prFile, '--no-open']);
  const prURL = prOpened.match(/url:\s*"?(https?:\/\/[^"\s]+)/)?.[1]; assert.ok(prURL);
  const prPage = await browser.newPage(); await prPage.goto(prURL);
  const prFrame = prPage.locator('iframe').first().contentFrame();
  const title = prFrame.getByRole('textbox', { name: 'Title', exact: true }), body = prFrame.getByRole('textbox', { name: 'PR body' });
  await prFrame.getByRole('status').filter({ hasText: 'up to date with disk' }).waitFor();
  await prFrame.getByRole('button', { name: 'Edit', exact: true }).click();
  await title.fill('Saved PR title'); await body.fill('\nSaved PR body 雪\n\n');
  await prFrame.getByRole('button', { name: 'Send', exact: true }).click();
  await until(async () => await readFile(prSource, 'utf8') === '# Saved PR title\n\nSaved PR body 雪\n\n');
  await prFrame.getByRole('status').filter({ hasText: 'Up to date with disk' }).waitFor();
  console.log('PASS: PR page Send wrote title and body exactly and watched the save.');
  await title.fill('Create PR title'); await body.fill('\nCreate PR body " \\ 雪\n\n');
  const actionText = '# Create PR title\n\nCreate PR body " \\ 雪\n\n';
  await prFrame.getByRole('button', { name: 'Create PR', exact: true }).click();
  let launch, captured;
  try {
    await until(async () => { try { launch = JSON.parse(await readFile(launchFile)); captured = JSON.parse(await readFile(captureFile)); return true; } catch { return false; } });
  } catch (error) {
    console.log(`PR conversation on failure:\n${await prPage.locator('body').innerText()}\nPR form:\n${await prFrame.locator('body').innerText()}`);
    try { console.log(`PR relay log:\n${await readFile(relayLog(await realpath(prFile)), 'utf8')}`); } catch {}
    throw error;
  }
  terminals.push(launch.terminal);
  assert.equal(launch.space, space); assert.equal(captured.cwd, prTarget.pr.repo);
  assert.deepEqual(captured.args, ['-r', '@-', '--body-file', await realpath(prSource)]); assert.equal(captured.text, actionText);
  const actual = JSON.parse(await run('hc', ['get', launch.terminal, '--json']));
  assert.equal(actual.labels['herdr.space'], space); assert.equal(actual.labels['herdr.tab'], launch.tab);
  await until(async () => (await exec('hc', ['read', launch.terminal])).stdout.includes('No GitHub access'));
  console.log(`Create PR launch: ${JSON.stringify(launch)}; hc get confirms space/tab labels.`);
  console.log(`Captured configured stub command: ${JSON.stringify(captured)}`);
  console.log(`hc read ${launch.terminal}:\n${(await run('hc', ['read', launch.terminal])).trim()}`);
  await until(async () => (await prPage.locator('body').innerText()).includes('Saved. Launched'));
  await run('lavish-axi', ['end', prFile]);
  await until(async () => { try { await access(relayPaths(prFile).lock); return false; } catch { return true; } });
  console.log('PASS: Create PR saved first, launched the configured stub command in the same herdr space and recorded repo, replied, and exited its relay.');

  // Trace only this page's watch-only worker through a wrapper of the real CLI.
  const realLavish = (await exec('which', ['lavish-axi'])).stdout.trim(), outsideCalls = path.join(dir, 'outside-calls');
  await executable('lavish-axi', `const fs=require('node:fs'),cp=require('node:child_process'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(outsideCalls)},JSON.stringify(args)+'\\n');try{process.stdout.write(cp.execFileSync(${JSON.stringify(realLavish)},args,{encoding:'utf8'}));}catch(error){process.stderr.write(error.stderr||error.message);process.exit(1);}`);
  await writeFile(outsideSource, '# Outside review\n\nInitial Markdown\n');
  const outsideOutput = await run(process.execPath, [cli, outsideSource, '--out', outsideFile], { env: { ...process.env, HC_TERMINAL_ID: '', LAVISH_KIT_LAVISH_TRANSPORT: 'cli' }, timeout: 15000 });
  const outsideURL = outsideOutput.match(/ready: (https?:\/\/\S+)/)?.[1]; assert.ok(outsideURL);
  const outsidePage = await browser.newPage(); await outsidePage.goto(outsideURL);
  const outsideFrame = outsidePage.locator('iframe').first().contentFrame();
  await outsideFrame.getByRole('heading', { name: 'Outside review' }).waitFor();
  await writeFile(outsideSource, '# Updated outside review\n\nChanged Markdown\n');
  await outsideFrame.getByRole('heading', { name: 'Updated outside review' }).waitFor();
  await until(async () => (await readFile(outsideCalls, 'utf8')).trim().split('\n').map(JSON.parse).some(args => args.length === 0));
  await run(realLavish, ['end', outsideFile]);
  await until(async () => { try { await access(relayPaths(outsideFile).lock); return false; } catch { return true; } });
  const outsideTrace = (await readFile(outsideCalls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(outsideTrace.every(args => !['poll', 'reply', 'end'].includes(args[0])));
  await assert.rejects(access(relayPaths(outsideFile).target));
  console.log('PASS: outside-herdr command returned, Markdown updated in the browser, watch-only worker never polled, and real session end stopped it.');
} catch (error) {
  primaryError = error;
} finally {
  const errors = [];
  try { if (browser) await browser.close(); } catch (error) { errors.push(error); }
  for (const page of [file, prFile, outsideFile]) {
    try {
    try { await exec('lavish-axi', ['end', page]); } catch {}
    try { await rm(relayLog(await realpath(page)), { force: true }); } catch {}
    await rm(page, { force: true });
    await rm(relayPaths(page).watch, { force: true });
    await rm(relayPaths(page).target, { force: true });
    await until(async () => { try { await access(relayPaths(page).lock); return false; } catch { return true; } });
    } catch (error) { errors.push(error); }
  }
  try { await cleanupTerminals({ journal, terminals, dir, run, errors }); }
  catch (error) {
    if (primaryError) throw new AggregateError([primaryError, error], 'E2E and cleanup failed');
    throw error;
  }
}
if (primaryError) throw primaryError;
