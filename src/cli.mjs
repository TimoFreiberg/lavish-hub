import path from 'node:path';
import { spawn } from 'node:child_process';
import { callHub, hubUrl, prepareTargetRequest, resolveHubIdentity, runHubOwner, validateSessionTitle } from './hub-runtime.mjs';
import { formatHubError } from './hub-errors.mjs';
import { resolveSessionId, validateSessionId } from './hub-workspace.mjs';
import { readMetadata, validateMetadata } from './hub-documents.mjs';
import { lavishCli, runtimeEnv } from './runtime.mjs';
import { createLavishClient } from './lavish-http.mjs';
import { resolveLavishPort } from './lavish-port.mjs';
import { themeCss, syntaxTheme, diffThemeCss } from './orangebox.mjs';

const usage = `usage: lavish-hub [listen|stop|status|url] [--workspace DIR] [--session ID] [--open] [--reopen] [--view ID]
       lavish-hub listen [--rev REV] [--base REV | --no-base] [--title TEXT]
       lavish-hub target [REV] [--base REV | --no-base] [--title TEXT] [--session ID] [--workspace DIR]
       lavish-hub publish FILE [--id ID] [--title T] [--metadata-file JSON] [--repo REPO] [--base-commit HEX] [--head-commit HEX] [--source-url URL] [--no-scope] [--workspace DIR] [--session ID] [--attention] [--open]
       lavish-hub tasks --file FILE [--workspace DIR] [--session ID]
       lavish-hub reply --batch ID [--text | --agent-reply] TEXT [--workspace DIR] [--session ID]
       lavish-hub reply PAGE --agent-reply TEXT
       lavish-hub context --batch ID [--workspace DIR] [--session ID]
       lavish-hub theme [css|syntax|diff-css]`;
const themeHelp = `Orangebox is Lavish Hub's dark theme for standalone HTML.

Use <html data-theme="orangebox">. Place the output of "lavish-hub theme css"
in a style element after any DaisyUI stylesheets. It includes a default page
background and foreground; authored styles may override them.

For syntax highlighting, "lavish-hub theme syntax" prints a Shiki-compatible
JSON theme. With @pierre/diffs, register it using registerCustomTheme('orangebox',
async () => syntaxTheme), then pass theme: 'orangebox', themeType: 'dark', and
preferredHighlighter: 'shiki-js' in the renderer options. Pass the output of
"lavish-hub theme diff-css" as unsafeCSS to color the diff's shadow DOM.

The CSS and JSON are self-contained: include them in the artifact or save them
as sibling assets. Do not rely on the viewer to inject them.`;
const publishHelp = `usage: lavish-hub publish FILE [--id ID] [--title T] [--metadata-file JSON] [--repo REPO] [--base-commit HEX] [--head-commit HEX] [--source-url URL] [--no-scope] [--workspace DIR] [--session ID] [--attention] [--open]

Local jj review: lavish-hub publish review.html
Remote PR review: lavish-hub publish review.html --repo org/repo --base-commit <hex> --head-commit <hex> --source-url https://github.com/org/repo/pull/123
Non-review artifact: lavish-hub publish notes.html --no-scope`;
const help = `${usage}

Run listen in the foreground to own a workspace hub and receive feedback as
agent-notification JSON lines. Use reply --batch <batchId> to respond to a notification.
See docs/hub.md for configuration and workflow details.`;
class UsageError extends Error { constructor(message) { super(message); this.name = 'UsageError'; } }

export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const target = args[0] && !args[0].startsWith('--') ? args.shift() : 'status';
  if (target === 'theme') {
    if (args.length > 1 || (args.length && !['--help', 'css', 'syntax', 'diff-css'].includes(args[0]))) throw new UsageError('theme accepts css, syntax, or diff-css');
    return { theme: args[0] === '--help' ? 'help' : (args[0] || 'help') };
  }
  if (target === 'reply' || target === 'context') {
    if (args.length === 1 && args[0] === '--help') return { commandHelp: target };
    if (target === 'reply' && args.length === 3 && !args[0].startsWith('-') && args[1] === '--agent-reply' && args[2]) return { reply: true, page: args[0], text: args[2] };
    const result = { hub: target };
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (['--batch', '--workspace', '--session'].includes(arg)) {
        const key = arg === '--batch' ? 'batchId' : arg.slice(2);
        if (result[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('-')) throw new UsageError(`${arg} requires one value`);
        result[key] = args[++i];
      } else if (target === 'reply' && ['--text', '--agent-reply', '--'].includes(arg)) {
        if (result.text !== undefined || !args[i + 1]) throw new UsageError(`${arg} requires one text value`);
        result.text = args[++i];
        if (arg === '--' && i !== args.length - 1) throw new UsageError('-- accepts one text value');
      } else if (target === 'reply' && result.text === undefined && !arg.startsWith('--')) result.text = arg;
      else throw new UsageError(`unknown argument ${arg}`);
    }
    if (!result.batchId || (target === 'reply' && !result.text)) throw new UsageError(`${target} requires --batch ID${target === 'reply' ? ' and reply text' : ''}`);
    try { if (result.session !== undefined) validateSessionId(result.session); } catch (error) { throw new UsageError(error.message); }
    return result;
  }
  if (target === 'publish' && args.length === 1 && args[0] === '--help') return { commandHelp: target };
  if (!['listen', 'stop', 'status', 'url', 'publish', 'tasks', 'target'].includes(target)) throw new UsageError(`unknown command ${target}`);
  const command = target;
  const result = { hub: command };
  if (command === 'publish') {
    result.file = args.shift();
    if (!result.file || result.file.startsWith('-')) throw new UsageError('publish requires a file');
  }
  if (command === 'target' && args[0] && !args[0].startsWith('-')) result.rev = args.shift();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--workspace') {
      if (result.workspace || !args[i + 1] || args[i + 1].startsWith('-')) throw new UsageError('--workspace requires one value');
      result.workspace = args[++i];
    } else if (arg === '--session' || (command === 'publish' && ['--id', '--title', '--metadata-file', '--repo', '--base-commit', '--head-commit', '--source-url'].includes(arg)) || (command === 'tasks' && arg === '--file') || (['listen', 'target'].includes(command) && ['--base', '--title'].includes(arg)) || (command === 'listen' && arg === '--rev')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (result[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('-')) throw new UsageError(`${arg} requires one value`);
      result[key] = args[++i];
    } else if (['listen', 'target'].includes(command) && arg === '--no-base') {
      if (result.noBase) throw new UsageError('--no-base given twice');
      result.noBase = true;
    } else if (command === 'status' && arg === '--view') {
      if (result.view !== undefined || !args[i + 1] || args[i + 1].startsWith('-')) throw new UsageError('--view requires one value');
      result.view = args[++i];
    } else if ((arg === '--open' && ['listen', 'status', 'publish'].includes(command)) || (arg === '--reopen' && command === 'listen') || (arg === '--attention' && command === 'publish') || (arg === '--no-scope' && command === 'publish')) {
      const key = arg === '--no-scope' ? 'noScope' : arg.slice(2);
      if (result[key]) throw new UsageError(`${arg} given twice`);
      result[key] = true;
    } else throw new UsageError(`unknown argument ${arg}`);
  }
  try {
    if (result.session !== undefined) validateSessionId(result.session);
    if (['listen', 'target'].includes(command) && result.title !== undefined) result.title = validateSessionTitle(result.title);
  } catch (error) { throw new UsageError(error.message); }
  if (result.base !== undefined && result.noBase) throw new UsageError('--base and --no-base are mutually exclusive');
  if (command === 'listen' && result.session !== undefined && result.title === undefined) throw new UsageError('listen with --session requires --title');
  if (command === 'target' && result.rev === undefined && result.base === undefined && !result.noBase && result.title === undefined) throw new UsageError('target requires REV, --base, --no-base, or --title');
  if (command === 'publish' && result.noScope && ['metadataFile', 'repo', 'baseCommit', 'headCommit', 'sourceUrl'].some(key => result[key] !== undefined)) throw new UsageError('--no-scope cannot be combined with metadata or scope flags');
  if (command === 'tasks' && !result.file) throw new UsageError('tasks requires --file');
  return result;
}

async function reply(page, text) {
  const env = { ...runtimeEnv(), LAVISH_AXI_PORT: String(await resolveLavishPort()) };
  await createLavishClient({ env }).verifyIfRunning();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [lavishCli, 'reply', page, '--agent-reply', text], { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) { process.kill(process.pid, signal); return; }
      resolve(code ?? 1);
    });
  });
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs([...args]);
    if (options.help) { console.log(help); return 0; }
    if (options.commandHelp) {
      console.log(options.commandHelp === 'publish' ? publishHelp : options.commandHelp === 'reply' ? 'usage: lavish-hub reply --batch ID [--text | --agent-reply] TEXT [--workspace DIR] [--session ID]\n       lavish-hub reply PAGE --agent-reply TEXT' : 'usage: lavish-hub context --batch ID [--workspace DIR] [--session ID]');
      return 0;
    }
    if (options.theme) {
      const outputs = {
        help: themeHelp,
        css: `${themeCss}\n:where(html[data-theme="orangebox"], html[data-theme="orangebox"] body) { background: var(--ob-bg); color: var(--ob-fg); }`,
        syntax: JSON.stringify(syntaxTheme, null, 2),
        'diff-css': diffThemeCss,
      };
      console.log(outputs[options.theme]);
      return 0;
    }
    if (options.reply) return await reply(options.page, options.text);
    let session;
    try { session = resolveSessionId(options); } catch (error) { throw new UsageError(error.message); }
    if (options.hub === 'reply') {
      const identity = await resolveHubIdentity(options);
      await createLavishClient().reply(path.join(identity.directory, 'hub.html'), options.text, { batchId: options.batchId });
      console.log(JSON.stringify({ status: 'sent', batchId: options.batchId }));
      return 0;
    }
    if (options.hub === 'context') {
      const result = await callHub('context', { ...options, body: { batchId: options.batchId } });
      if (result.domSnapshot) process.stdout.write(result.domSnapshot);
      return 0;
    }
    if (options.hub === 'listen' && session && options.title === undefined) throw new UsageError('listen with --session requires --title');
    if (options.hub === 'listen') return await runHubOwner(options);
    if (options.hub === 'target') {
      const body = await prepareTargetRequest(options);
      const result = await callHub('target', { ...options, body });
      console.log(`Hub target: ${result.target || '(working copy)'}${result.base ? `; base: ${result.base}` : ''}${result.title ? `; title: ${result.title}` : ''}.`);
      return 0;
    }
    if (options.hub === 'url') { console.log(await hubUrl(options)); return 0; }
    if (['publish', 'tasks'].includes(options.hub)) {
      let body;
      if (options.hub === 'publish') {
        const inline = Object.fromEntries([['repo', 'reviewedRepository'], ['baseCommit', 'baseCommit'], ['headCommit', 'headCommit'], ['sourceUrl', 'sourceUrl']].filter(([key]) => options[key] !== undefined).map(([key, field]) => [field, options[key]]));
        const scope = options.noScope ? { metadata: {} } : options.metadataFile || Object.keys(inline).length
          ? { metadata: validateMetadata({ ...(options.metadataFile ? await readMetadata(options.metadataFile) : {}), ...inline }) }
          : { autoScope: true };
        body = { id: options.id, title: options.title, file: path.resolve(options.file), ...scope, ...(options.attention ? { attention: true } : {}) };
      } else body = { kind: options.hub, file: path.resolve(options.file) };
      const result = await callHub(options.hub === 'publish' ? 'publish' : 'attach', { ...options, body });
      console.log(options.hub === 'publish' ? JSON.stringify({ id: result.id, url: result.url ?? null, title: result.title, scope: result.scope ?? null }) : `Configured ${options.hub}.`);
      if (options.open) {
        if (options.hub === 'publish') await callHub('navigate', { ...options, body: { id: result.id } });
        await callHub('open', { ...options, ...(options.hub === 'publish' ? { body: { view: result.id } } : {}) });
      }
      return 0;
    }
    if (options.hub === 'status' && options.view) await callHub('navigate', { ...options, body: { id: options.view } });
    const result = await callHub(options.hub, options);
    if (options.open) await callHub('open', { ...options, ...(options.view ? { body: { view: options.view } } : {}) });
    console.log(options.hub === 'stop' ? 'Hub owner stopping.' : `Hub owner running for ${result.workspace}${result.available ? '' : ' (workspace unavailable)'}${result.session ? `; session: ${result.session}` : ''}${result.title ? `; title: ${result.title}` : ''}${result.target ? `; target: ${result.target}` : ''}${result.base ? `; base: ${result.base}` : ''}.`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) { console.error(error.message ? `${formatHubError(error)}\n${usage}` : usage); return 2; }
    console.error(formatHubError(error)); return 1;
  }
}
