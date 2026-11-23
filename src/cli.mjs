import path from 'node:path';
import { spawn } from 'node:child_process';
import { callHub, hubUrl, runHubOwner } from './hub-runtime.mjs';
import { readMetadata } from './hub-documents.mjs';
import { lavishCli, runtimeEnv } from './runtime.mjs';
import { createLavishClient } from './lavish-http.mjs';
import { resolveLavishPort } from './lavish-port.mjs';
import { themeCss, syntaxTheme, diffThemeCss } from './orangebox.mjs';

const usage = `usage: lavish-hub [listen|stop|status|url] [--workspace DIR] [--open] [--reopen] [--view ID]
       lavish-hub publish FILE --id ID [--title T] [--metadata-file JSON] [--workspace DIR] [--attention] [--open]
       lavish-hub tasks --file FILE [--workspace DIR]
       lavish-hub reply PAGE --agent-reply TEXT
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
const help = `${usage}

Run listen in the foreground to own a workspace hub and receive feedback as
agent-notification JSON lines. Use reply to respond to the page in a notification.
See docs/hub.md for configuration and workflow details.`;
class UsageError extends Error {}

export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const target = args[0] && !args[0].startsWith('--') ? args.shift() : 'status';
  if (target === 'theme') {
    if (args.length > 1 || (args.length && !['--help', 'css', 'syntax', 'diff-css'].includes(args[0]))) throw new UsageError('theme accepts css, syntax, or diff-css');
    return { theme: args[0] === '--help' ? 'help' : (args[0] || 'help') };
  }
  if (target === 'reply') {
    if (args.length !== 3 || !args[0] || args[0].startsWith('-') || args[1] !== '--agent-reply' || !args[2]) throw new UsageError('reply requires PAGE --agent-reply TEXT');
    return { reply: true, page: args[0], text: args[2] };
  }
  if (!['listen', 'stop', 'status', 'url', 'publish', 'tasks'].includes(target)) throw new UsageError(`unknown command ${target}`);
  const command = target;
  const result = { hub: command };
  if (command === 'publish') {
    result.file = args.shift();
    if (!result.file || result.file.startsWith('-')) throw new UsageError('publish requires a file');
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--workspace') {
      if (result.workspace || !args[i + 1] || args[i + 1].startsWith('-')) throw new UsageError('--workspace requires one value');
      result.workspace = args[++i];
    } else if ((command === 'publish' && ['--id', '--title', '--metadata-file'].includes(arg)) || (command === 'tasks' && arg === '--file')) {
      const key = arg === '--metadata-file' ? 'metadataFile' : arg.slice(2);
      if (result[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('-')) throw new UsageError(`${arg} requires one value`);
      result[key] = args[++i];
    } else if (command === 'status' && arg === '--view') {
      if (result.view !== undefined || !args[i + 1] || args[i + 1].startsWith('-')) throw new UsageError('--view requires one value');
      result.view = args[++i];
    } else if ((arg === '--open' && ['listen', 'status', 'publish'].includes(command)) || (arg === '--reopen' && command === 'listen') || (arg === '--attention' && command === 'publish')) {
      const key = arg.slice(2);
      if (result[key]) throw new UsageError(`${arg} given twice`);
      result[key] = true;
    } else throw new UsageError(`unknown argument ${arg}`);
  }
  if (command === 'publish' && !result.id) throw new UsageError('publish requires --id');
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
    if (options.hub === 'listen') return await runHubOwner(options);
    if (options.hub === 'url') { console.log(await hubUrl(options)); return 0; }
    if (['publish', 'tasks'].includes(options.hub)) {
      const body = options.hub === 'publish'
        ? { id: options.id, title: options.title, file: path.resolve(options.file), ...(options.metadataFile ? { metadata: await readMetadata(options.metadataFile) } : {}), ...(options.attention ? { attention: true } : {}) }
        : { kind: options.hub, file: path.resolve(options.file) };
      const result = await callHub(options.hub === 'publish' ? 'publish' : 'attach', { ...options, body });
      console.log(options.hub === 'publish' ? (result?.url ? `Registered document ${options.id}: ${result.url}` : `Registered document ${options.id}.`) : `Configured ${options.hub}.`);
      if (options.open) {
        if (options.hub === 'publish') await callHub('navigate', { ...options, body: { id: options.id } });
        await callHub('open', { ...options, ...(options.hub === 'publish' ? { body: { view: options.id } } : {}) });
      }
      return 0;
    }
    if (options.hub === 'status' && options.view) await callHub('navigate', { ...options, body: { id: options.view } });
    const result = await callHub(options.hub, options);
    if (options.open) await callHub('open', { ...options, ...(options.view ? { body: { view: options.view } } : {}) });
    console.log(options.hub === 'stop' ? 'Hub owner stopping.' : `Hub owner running for ${result.workspace}${result.available ? '' : ' (workspace unavailable)'}.`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) { console.error(error.message ? `lavish-hub: ${error.message}\n${usage}` : usage); return 2; }
    console.error(`lavish-hub: ${error.message}`); return 1;
  }
}
