import path from 'node:path';
import { spawn } from 'node:child_process';
import { callHub, runHubOwner } from './hub-runtime.mjs';
import { readMetadata } from './hub-documents.mjs';
import { lavishCli, runtimeEnv } from './runtime.mjs';

const usage = `usage: lavish-kit hub [listen|stop|status] [--workspace DIR] [--open] [--reopen]
       lavish-kit hub publish FILE --id ID [--title T] [--metadata-file JSON] [--workspace DIR] [--open]
       lavish-kit hub tasks --file FILE [--workspace DIR]
       lavish-kit hub pr [--file FILE] [--rev REV] [--workspace DIR]
       lavish-kit reply PAGE --agent-reply TEXT`;
const help = `${usage}

Run hub listen in the foreground to own a workspace hub and receive feedback as
agent-notification JSON lines. Use reply to respond to the page in a notification.
The PR head defaults to @-; launch resolves it to a commit before opening a terminal.
See docs/hub.md for configuration and workflow details.`;
class UsageError extends Error {}

export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const target = args.shift();
  if (target === 'reply') {
    if (args.length !== 3 || !args[0] || args[0].startsWith('-') || args[1] !== '--agent-reply' || !args[2]) throw new UsageError('reply requires PAGE --agent-reply TEXT');
    return { reply: true, page: args[0], text: args[2] };
  }
  if (target !== 'hub') throw new UsageError(target ? `unknown command ${target}` : '');
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'status';
  if (!['listen', 'stop', 'status', 'publish', 'tasks', 'pr'].includes(command)) throw new UsageError(`unknown hub command ${command}`);
  const result = { hub: command };
  if (command === 'publish') {
    result.file = args.shift();
    if (!result.file || result.file.startsWith('-')) throw new UsageError('hub publish requires a file');
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--workspace') {
      if (result.workspace || !args[i + 1] || args[i + 1].startsWith('-')) throw new UsageError('--workspace requires one value');
      result.workspace = args[++i];
    } else if ((command === 'publish' && ['--id', '--title', '--metadata-file'].includes(arg)) || (['tasks', 'pr'].includes(command) && arg === '--file') || (command === 'pr' && arg === '--rev')) {
      const key = arg === '--metadata-file' ? 'metadataFile' : arg.slice(2);
      if (result[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('-')) throw new UsageError(`${arg} requires one value`);
      result[key] = args[++i];
    } else if (command === 'status' && arg === '--view') {
      if (result.view !== undefined || !args[i + 1] || args[i + 1].startsWith('-')) throw new UsageError('--view requires one value');
      result.view = args[++i];
    } else if ((arg === '--open' && ['listen', 'status', 'publish'].includes(command)) || (arg === '--reopen' && command === 'listen')) {
      const key = arg.slice(2);
      if (result[key]) throw new UsageError(`${arg} given twice`);
      result[key] = true;
    } else throw new UsageError(`unknown hub argument ${arg}`);
  }
  if (command === 'publish' && !result.id) throw new UsageError('hub publish requires --id');
  if (command === 'tasks' && !result.file) throw new UsageError('hub tasks requires --file');
  if (command === 'pr' && !result.file && !result.rev) throw new UsageError('hub pr requires --file or --rev');
  return result;
}

async function reply(page, text) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [lavishCli, 'reply', page, '--agent-reply', text], { env: runtimeEnv(), stdio: 'inherit' });
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
    if (options.reply) return await reply(options.page, options.text);
    if (options.hub === 'listen') return await runHubOwner(options);
    if (['publish', 'tasks', 'pr'].includes(options.hub)) {
      const body = options.hub === 'publish'
        ? { id: options.id, title: options.title, file: path.resolve(options.file), ...(options.metadataFile ? { metadata: await readMetadata(options.metadataFile) } : {}) }
        : { kind: options.hub, ...(options.file ? { file: path.resolve(options.file) } : {}), ...(options.rev ? { rev: options.rev } : {}) };
      await callHub(options.hub === 'publish' ? 'publish' : options.hub === 'pr' ? 'configurePr' : 'attach', { ...options, body });
      if (options.open) await callHub('open', options);
      console.log(options.hub === 'publish' ? `Registered document ${options.id}.` : `Configured ${options.hub}.`);
      return 0;
    }
    if (options.hub === 'status' && options.view) await callHub('navigate', { ...options, body: { id: options.view } });
    const result = await callHub(options.hub, options);
    if (options.open) await callHub('open', options);
    console.log(options.hub === 'stop' ? 'Hub owner stopping.' : `Hub owner running for ${result.workspace}${result.available ? '' : ' (workspace unavailable)'}.`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) { console.error(error.message ? `lavish-kit: ${error.message}\n${usage}` : usage); return 2; }
    console.error(`lavish-kit: ${error.message}`); return 1;
  }
}
