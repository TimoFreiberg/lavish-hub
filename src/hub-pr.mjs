import { execFile } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { readCreatePr } from './config.mjs';
import { quote } from './relay.mjs';

const exec = promisify(execFile);

export async function createHubPr(directory, cwd, documents, jj, { run = exec, env = process.env, log = console.error } = {}) {
  const attempts = path.join(directory, 'attempts');
  await mkdir(attempts, { recursive: true, mode: 0o700 });
  return async body => {
    if (typeof body.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.id)) throw new Error('Invalid request ID');
    const file = path.join(attempts, `${body.id}.json`);
    let checkpoint;
    try { checkpoint = await open(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { return JSON.parse(await readFile(file, 'utf8')); } catch { return { id: body.id, status: 'interrupted-or-running' }; }
    }
    try { await checkpoint.writeFile(JSON.stringify({ id: body.id, status: 'interrupted-or-running' })); await checkpoint.sync(); }
    finally { await checkpoint.close(); }
    let result, target;
    try {
      target = await documents.savePrForLaunch(body);
      const head = await jj.prHead(target.rev);
      const config = await readCreatePr({ env });
      if (!config.argv) throw new Error(config.reason);
      const argv = [...config.argv, '-r', head.revision, '--body-file', target.source];
      const command = `cd ${quote(cwd)} && ${argv.map(quote).join(' ')}`;
      if (head.warning) log(head.warning);
      result = { id: body.id, status: 'fallback', ...head, savedHash: target.savedHash, source: target.source, argv, command, message: 'Draft saved. Run this command interactively; launch does not confirm PR creation.' };
      if (env.HC_TERMINAL_ID) {
        let space;
        try {
          const terminal = JSON.parse((await run('hc', ['get', env.HC_TERMINAL_ID, '--json'], { timeout: 2000 })).stdout);
          if (terminal.state === 'live') space = terminal.labels?.['herdr.space'];
        } catch { /* No usable interactive terminal; show the command instead. */ }
        if (space) {
          // The attempt checkpoint above must be durable before this external call.
          try {
            const response = JSON.parse((await run('herdr-app', ['do', 'tab.new', JSON.stringify({ space, folder: cwd, name: 'Create PR', argv })], { timeout: 5000 })).stdout);
            if (response.error || response.space !== space || !response.tab || !response.terminal) throw new Error(response.error || 'herdr did not acknowledge the terminal');
            result = { ...result, status: 'launched', message: 'Draft saved. Command launched in an interactive terminal; this does not confirm PR creation.', tab: response.tab };
          } catch (error) {
            result = { ...result, status: 'uncertain', message: `Terminal launch was not confirmed: ${error.message}. Check herdr before running or submitting again.` };
          }
        }
      }
    } catch (error) { result = { id: body.id, status: 'error', ...(target ? { savedHash: target.savedHash, source: target.source } : {}), message: `${target ? 'Draft saved. ' : ''}${error.message}` }; }
    await writeFile(file, JSON.stringify(result), { mode: 0o600 });
    return result;
  };
}
