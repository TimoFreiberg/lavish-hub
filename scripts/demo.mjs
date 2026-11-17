#!/usr/bin/env node
// Generate a fixed jj repository and review documents, then run the real hub
// against them with private state so it never touches the normal hub.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const cli = path.join(root, 'bin', 'lavish-kit');
const lavishCli = path.join(root, 'vendor', 'lavish', 'dist', 'cli.mjs');
const marker = '.lavish-kit-demo';
export const defaultDir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'lavish-kit-demo');

/** Environment for the demo hub and every command that talks to it. */
export function demoEnv(dir, port = 4399) {
  return {
    ...process.env,
    XDG_DATA_HOME: path.join(dir, 'data'),
    XDG_STATE_HOME: path.join(dir, 'state'),
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    LAVISH_AXI_STATE_DIR: path.join(dir, 'state', 'lavish'),
    LAVISH_AXI_PORT: String(port),
    LAVISH_AXI_TELEMETRY: '0',
    JJ_CONFIG: path.join(dir, 'config', 'jj', 'config.toml'),
  };
}

const lines = (count, fn) => Array.from({ length: count }, (_, i) => fn(i + 1)).join('\n') + '\n';
const word = i => ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'][i % 8];

const longParagraph = 'Review pages are read on narrow laptop screens as often as on wide monitors, so every paragraph in this guide is intentionally long enough to wrap several times. ' +
  'It mentions configuration, caching, retries and the reasons each default was chosen, which makes it a realistic stand-in for prose that people actually write in design notes and READMEs.';

function baseFiles() {
  return {
    'README.md': '# Widget service\n\nA small service used to exercise the review hub.\n\n## Usage\n\n```sh\nnpm start\n```\n',
    'config.json': JSON.stringify({ port: 8080, retries: 3, cache: { ttl: 60 } }, null, 2) + '\n',
    'scripts/run.sh': '#!/bin/sh\nset -eu\nexec node dist/app.js "$@"\n',
    'src/app.ts': lines(30, i => i === 1 ? "import { load } from './config-loader';" : i === 10 ? 'export function start(port: number) {' : i === 20 ? '}' : `  // step ${i}: ${word(i)}`),
    'src/util.ts': 'export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));\n',
    'src/legacy.ts': lines(12, i => `export const legacy${i} = ${i};`),
    'src/config-loader.ts': lines(20, i => i === 1 ? 'export function load(file: string) {' : i === 20 ? '}' : `  const value${i} = read(file, ${i});`),
    'src/constants.ts': lines(30, i => `export const LIMIT_${i} = ${i * 10};`),
    'src/big.ts': lines(800, i => `export function handler${i}(input: string): string { return input + '${word(i)}'; }`),
    'docs/guide.md': `# Guide\n\n${longParagraph}\n\n## Details\n\n${longParagraph}\n`,
  };
}

const longSubjects = ['Fix typo', 'Raise the retry limit for slow upstreams', 'Tweak constant',
  'Make the connection pool size configurable through the environment so deployments can tune it',
  'Bump limit', 'Use a named constant instead of a magic number in the cache path', 'Adjust LIMIT'];

const unicodeBody = `Emoji: 🚀✨🐛 — CJK: 差分を確認してください。中文评论。
RTL: هذا نص عربي للاختبار.
Escaping: <script>alert(1)</script> & "quotes" 'apostrophes'
`;

const trailersBody = `Load configuration from one place so the helpers can be shared.

The old module mixed parsing with side effects:

- it read files at import time
- it swallowed errors, which hid misconfiguration
- it duplicated clamp logic

Example of the new call:

    const config = load('config.json');
    start(config.port);

Background is in https://example.com/a/very/long/path/to/a/design/document/that/explains/the/reasoning/in/detail?section=configuration&version=2

Co-authored-by: Demo Person <demo@example.invalid>
Refs: DEMO-42
`;

/** Create the demo repository and documents under dir, replacing an earlier demo there. */
export async function generateDemo(dir) {
  await reset(dir);
  const repo = path.join(dir, 'repo');
  const jjConfig = demoEnv(dir).JJ_CONFIG;
  await mkdir(path.dirname(jjConfig), { recursive: true });
  await writeFile(jjConfig, '[user]\nname = "Demo Author"\nemail = "demo@example.invalid"\n');
  let seq = 0;
  const jj = (...args) => {
    seq++;
    const time = new Date(Date.UTC(2026, 0, 5, 9, 0) + seq * 7 * 60_000).toISOString().replace('.000Z', '+00:00');
    return execFileSync('jj', ['--no-pager', '--color=never', ...args], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, JJ_CONFIG: jjConfig, JJ_RANDOMNESS_SEED: String(seq), JJ_TIMESTAMP: time, JJ_OP_TIMESTAMP: time, JJ_OP_HOSTNAME: 'demo', JJ_OP_USERNAME: 'demo' },
    }).trim();
  };
  const write = async (file, content) => {
    await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await writeFile(path.join(repo, file), content);
  };
  const edit = async (file, fn) => write(file, fn(await readFile(path.join(repo, file), 'utf8')));
  const remove = file => rm(path.join(repo, file));
  const move = async (from, to, fn = text => text) => { const text = await readFile(path.join(repo, from), 'utf8'); await remove(from); await write(to, fn(text)); };
  const commit = message => jj('commit', '-m', message);

  await mkdir(repo, { recursive: true });
  jj('git', 'init');
  for (const [file, content] of Object.entries(baseFiles())) await write(file, content);
  commit('Initial widget service');
  jj('bookmark', 'create', 'main', '-r', '@-');
  jj('config', 'set', '--repo', 'revset-aliases."trunk()"', 'main');
  jj('config', 'set', '--repo', 'revset-aliases."immutable_heads()"', 'builtin_immutable_heads() | description(exact:"Already landed upstream\n")');

  await edit('README.md', text => text + '\nSee CHANGELOG for release notes.\n');
  commit('Already landed upstream');

  // A long list of tiny commits; they barely grow the diff.
  for (let i = 1; i <= 25; i++) {
    await edit('src/constants.ts', text => text.replace(`LIMIT_${i} = ${i * 10};`, `LIMIT_${i} = ${i * 10 + 1};`));
    commit(`${longSubjects[i % longSubjects.length]} ${i}`);
  }

  await edit('src/app.ts', text => text.replace('// step 3: delta', '// step 3: validate input').replace('// step 4: echo', '// step 4: echo the request id'));
  commit('Validate input');

  await write('src/retry.ts', lines(60, i => i === 1 ? 'export async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {' : i === 60 ? '}' : `  // attempt bookkeeping line ${i}`));
  commit('Add a retry helper that wraps any promise-returning function with exponential backoff, jitter, cancellation support and a configurable attempt limit');

  await remove('src/legacy.ts');
  await move('src/util.ts', 'src/helpers.ts');
  commit(`Move helpers and drop the legacy module\n\n${trailersBody}`);

  await move('src/config-loader.ts', 'src/load-config.ts', text => text.replace('read(file, 5)', 'readCached(file, 5)'));
  await edit('src/app.ts', text => text.replace('./config-loader', './load-config'));
  commit(`Rename the config loader\n\n${'This paragraph is a single unwrapped line that keeps going, as happens when a message is pasted from a chat window or an editor without hard wrapping. '.repeat(4).trim()}\n\nToken: ${'a1b2c3d4e5'.repeat(20)}\n`);

  await edit('src/big.ts', text => text.split('\n').map((line, i) => i % 40 === 5 ? line.replace("return input", "return input.trim()") : line).join('\n'));
  commit(`Trim handler input ✨ 差分 تحسين <script>alert(1)</script>\n\n${unicodeBody}`);

  await write('src/generated/table.ts', lines(1500, i => `  [${i}, '${word(i)}-${i.toString(16)}'],`));
  commit('');

  await write('data.json', JSON.stringify({ items: Array.from({ length: 120 }, (_, i) => ({ id: i, name: word(i), tags: [word(i + 1), word(i + 2)] })) }));
  await write('src/token.ts', `export const TOKEN = '${'x9'.repeat(150)}';\n`);
  await edit('docs/guide.md', text => text.replace('## Details', `## Details\n\n${longParagraph.replace('narrow laptop screens', 'phones, narrow laptop screens')}`));
  commit('Add fixture data and expand the guide');

  await edit('config.json', text => text.replace('"retries": 3,', '"retries": 3,   '));
  await edit('src/helpers.ts', text => text);
  await write('src/indent.ts', 'export function f() {\n\treturn 1;\n}\n');
  await write('src/no-newline.ts', 'export const end = true;');
  await write('src/crlf.txt', 'line one\r\nline two\r\n');
  await write('src/empty.txt', '');
  await write('assets/logo.bin', Buffer.from([0, 1, 2, 3, 255, 254, 0, 0, 137, 80, 78, 71]));
  await chmod(path.join(repo, 'scripts/run.sh'), 0o755);
  await write('src/features/billing/invoices/exports/formats/spreadsheet/columns/currency.ts', "export const currency = 'EUR';\n");
  for (let i = 1; i <= 40; i++) await write(`many/file-${String(i).padStart(2, '0')}.txt`, `${i}\n`);
  commit('Odd file cases');
  await edit('src/indent.ts', text => text.replace('\treturn 1;', '    return 1;'));
  commit('Use spaces for indentation');

  await edit('README.md', text => text + '\nWork in progress: not committed yet.\n');
  jj('status');

  const base = jj('log', '--no-graph', '-r', 'main', '-T', 'commit_id');
  const head = jj('log', '--no-graph', '-r', '@', '-T', 'commit_id');
  await writeDocs(path.join(dir, 'docs'), { base, head });
  return { repo, docs: path.join(dir, 'docs'), base, head };
}

async function writeDocs(docs, { base, head }) {
  await mkdir(path.join(docs, 'img'), { recursive: true });
  const tasks = ['# Tasks', '', 'Work through these before merging.', ''];
  for (let i = 1; i <= 25; i++) {
    tasks.push(`- [${i % 3 === 0 ? 'x' : ' '}] ${i % 7 === 0 ? `A very long task that explains exactly what needs to happen, why it matters for this change, and which follow-up depends on it (item ${i})` : `Task ${i}: ${word(i)} the ${word(i + 3)} path`}`);
    if (i % 5 === 0) tasks.push(`  - [ ] Nested step for task ${i}`, `  - [x] Another nested step for task ${i}`);
    if (i % 8 === 0) tasks.push('', `Notes after task ${i}: not a task line.`, '');
  }
  await writeFile(path.join(docs, 'tasks.md'), tasks.join('\n') + '\n');
  await writeFile(path.join(docs, 'notes.md'), `---
title: Review notes
reviewer: demo
---

# Review notes

${longParagraph}

## Findings

### Configuration

#### Caching

##### Edge cases

> Cached reads can return stale values after a config reload.

![Data flow](img/diagram.svg)

\`\`\`ts
export const ttl: number = 60;
\`\`\`

\`\`\`python
def ttl() -> int:
    return 60
\`\`\`

\`\`\`sh
jj log -r 'trunk()..@'
\`\`\`

| File | Lines | Status | Owner | Reviewed | Notes | Follow-up | Ticket |
| --- | --- | --- | --- | --- | --- | --- | --- |
| src/load-config.ts | 20 | modified | config | yes | cached reads need invalidation on reload | add a test | DEMO-1 |
| src/retry.ts | 60 | added | core | partially | backoff constants are hard-coded | make them configurable | DEMO-2 |

See [the guide](https://example.com/guide) and [the retry section](#configuration).
`);
  await writeFile(path.join(docs, 'short.md'), '# Short\n\nTwo lines only.\n');
  await writeFile(path.join(docs, 'review.css'), 'body { font-family: system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; }\ntable { border-collapse: collapse; }\ntd, th { border: 1px solid #888; padding: .3rem .6rem; }\n');
  await writeFile(path.join(docs, 'img', 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80"><rect x="5" y="20" width="90" height="40" fill="#4a7"/><text x="15" y="45">config</text><line x1="95" y1="40" x2="215" y2="40" stroke="#333"/><rect x="215" y="20" width="90" height="40" fill="#47a"/><text x="230" y="45">app</text></svg>\n');
  await writeFile(path.join(docs, 'review.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Review</title><link rel="stylesheet" href="review.css"></head>
<body>
<h1>Review of the configuration change</h1>
<section><h2>Overview</h2><p>${longParagraph}</p><img src="img/diagram.svg" alt="Data flow"></section>
<section><h2>Files</h2><table><tr><th>File</th><th>Verdict</th></tr><tr><td>src/load-config.ts</td><td>Needs a test</td></tr><tr><td>src/retry.ts</td><td>Looks good</td></tr></table></section>
<section><h2>Sample</h2><pre><code>const config = load('config.json');
start(config.port);</code></pre></section>
</body></html>
`);
  await writeFile(path.join(docs, 'scope.json'), JSON.stringify({ reviewedRepository: 'widget-service', baseCommit: base, headCommit: head, sourceUrl: 'https://example.com/review' }, null, 2) + '\n');
}

function quiet(command, args, env) {
  return spawnSync(command, args, { env, stdio: 'ignore' }).status;
}

/** Stop the demo hub owner and its Lavish server, ignoring ones that are not running. */
export async function stopDemo(dir, port = 4399) {
  const env = demoEnv(dir, port);
  const repo = path.join(dir, 'repo');
  if (quiet(process.execPath, [cli, 'hub', 'stop', '--workspace', repo], env) === 0) {
    for (let i = 0; i < 50 && quiet(process.execPath, [cli, 'hub', '--workspace', repo], env) === 0; i++) await new Promise(r => setTimeout(r, 200));
  }
  if (existsSync(lavishCli)) quiet(process.execPath, [lavishCli, 'stop'], env);
}

async function reset(dir) {
  try { await stat(dir); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, marker), ''); return; }
  if (!existsSync(path.join(dir, marker))) throw new Error(`${dir} exists but is not a demo directory; refusing to replace it`);
  // Stop the previous run on whatever port it used, before its state disappears.
  const port = Number(await readFile(path.join(dir, 'port'), 'utf8').catch(() => '4399'));
  await stopDemo(dir, Number.isInteger(port) ? port : 4399);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, marker), '');
}

function build() {
  const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' });
  if (!existsSync(path.join(root, 'node_modules'))) run('npm', ['ci']);
  if (!existsSync(lavishCli) || !existsSync(path.join(root, 'dist', 'hub-markdown.js'))) run(process.execPath, ['scripts/prepare-check.mjs']);
  else run(process.execPath, ['build.mjs', '.', 'dist']);
}

function parse(args) {
  const options = { dir: defaultDir, port: 4399, open: true, stop: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dir') options.dir = path.resolve(args[++i]);
    else if (arg === '--port') options.port = Number(args[++i]);
    else if (arg === '--no-open') options.open = false;
    else if (arg === '--stop') options.stop = true;
    else throw new Error(`usage: demo.mjs [--dir DIR] [--port N] [--no-open] [--stop]`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('--port must be a TCP port');
  return options;
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.stop) {
    const recorded = Number(await readFile(path.join(options.dir, 'port'), 'utf8').catch(() => ''));
    await stopDemo(options.dir, process.argv.includes('--port') || !Number.isInteger(recorded) || !recorded ? options.port : recorded);
    return 0;
  }
  build();
  const { repo, docs } = await generateDemo(options.dir);
  await writeFile(path.join(options.dir, 'port'), String(options.port));
  const env = demoEnv(options.dir, options.port);
  const hub = (...args) => execFileSync(process.execPath, [cli, 'hub', ...args, '--workspace', repo], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  const child = spawn(process.execPath, [cli, 'hub', 'listen', '--workspace', repo], { env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))));
  const deadline = Date.now() + 60_000;
  while (quiet(process.execPath, [cli, 'hub', '--workspace', repo], env) !== 0) {
    if (child.exitCode !== null || Date.now() > deadline) { child.kill('SIGTERM'); console.error('demo: hub did not start'); return await exited || 1; }
    await new Promise(r => setTimeout(r, 300));
  }
  try {
    hub('tasks', '--file', path.join(docs, 'tasks.md'));
    hub('publish', path.join(docs, 'notes.md'), '--id', 'notes', '--title', 'Review notes', '--metadata-file', path.join(docs, 'scope.json'));
    hub('publish', path.join(docs, 'short.md'), '--id', 'short', '--title', 'A much longer document title that should wrap or truncate in the navigation');
    hub('publish', path.join(docs, 'review.html'), '--id', 'review', '--title', 'Review HTML');
    hub('--view', 'commits', ...(options.open ? ['--open'] : []));
  } catch (error) {
    child.kill('SIGTERM');
    await exited;
    throw error;
  }
  console.error(`demo: ${options.dir} on port ${options.port}; stop with Ctrl-C or just demo-stop`);
  return exited;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main().then(code => { process.exitCode = code; }, error => { console.error(`demo: ${error.message}`); process.exitCode = 1; });
}
