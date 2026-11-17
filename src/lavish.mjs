import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { lavishCli, runtimeEnv } from './runtime.mjs';

import { createLavishClient } from './lavish-http.mjs';

const exec = promisify(execFile);

export async function registerArtifact(payload, { now = Date.now, run = exec, delay = setTimeout } = {}) {
  let directory;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), 'lavish-artifact-'));
    const ack = path.join(directory, 'ack.json'), deadline = now() + 2000;
    await writeFile(ack, JSON.stringify({pending:true}), { flag: 'wx', mode: 0o600 });
    // A successful command only means queued. The mod acknowledges stored artifacts.
    await run('herdr-app', ['do', `task-tree.artifact:${JSON.stringify({ ...payload, ack })}`], { timeout: 2000 });
    while (now() < deadline) {
      try {
        const reply = JSON.parse(await readFile(ack, 'utf8'));
        if (reply.ok === true) return true;
        if (reply.ok === false) return false;
      } catch { /* Not written yet, or a write is still in progress. */ }
      await delay(Math.min(25, Math.max(0, deadline - now())));
    }
  } catch { /* Registration is optional. */ }
  finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  return false;
}

export async function prepareReview(file, { reopen = false, log = console.log } = {}) {
  file = path.resolve(file);
  let result;
  await createLavishClient().verifyIfRunning();
  try {
    await readFile(lavishCli, { flag: 'r' });
    result = await exec(process.execPath, [lavishCli, file, '--no-open', ...(reopen ? ['--reopen'] : [])], { env: runtimeEnv() });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Vendored Lavish build missing; build the package for development');
    throw new Error(error.stderr?.trim() || `lavish-axi failed: ${error.message}`);
  }
  if (/^\s*status:\s*user-ended\s*$/m.test(result.stdout)) {
    log(`The user ended the Lavish review of ${file}; pass --reopen only if they ask to see it again.`);
    return { ended: true };
  }
  const url = result.stdout.match(/^\s*url:\s*"?(https?:\/\/[^"\s]+)"?\s*$/m)?.[1];
  if (!url) throw new Error(result.stderr?.trim() || 'lavish-axi printed no review URL');
  return { url };
}

export async function presentReview(file, url, { title, open = false, log = console.log } = {}) {
  file = path.resolve(file);
  if (title === undefined) {
    const html = await readFile(file, 'utf8');
    title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1].trim() || path.basename(file);
  }
  let registered = false;
  if (process.env.HC_TERMINAL_ID) {
    registered = await registerArtifact({ terminal: process.env.HC_TERMINAL_ID, path: file, title });
  }
  if (open && !registered) {
    try { await exec(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]); }
    catch (error) { throw new Error(error.stderr?.trim() || `browser open failed: ${error.message}`); }
  }
  log(registered
    ? `Lavish review of ${file} is listed under the task's Artifacts.`
    : `Lavish review of ${file} ready: ${url}${open ? '' : ' (ask the user to open it)'}`);
  return { url, registered };
}

