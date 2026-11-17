import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { ensureRelay, quote, recordTarget } from './relay.mjs';
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

export async function prepareReview(file, { reopen = false, log = console.log, vendored = false } = {}) {
  file = path.resolve(file);
  let result;
  const cli = new URL('../vendor/lavish/dist/cli.mjs', import.meta.url);
  if (vendored) await createLavishClient({ vendored: true }).verifyIfRunning();
  try {
    if (vendored) await readFile(cli, { flag: 'r' });
    result = await exec(vendored ? process.execPath : 'lavish-axi', [...(vendored ? [fileURLToPath(cli)] : []), file, '--no-open', ...(reopen ? ['--reopen'] : [])]);
  } catch (error) {
    if (vendored && error.code === 'ENOENT') throw new Error('Vendored Lavish build missing; run pnpm --dir vendor/lavish install --frozen-lockfile and pnpm --dir vendor/lavish build');
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

export async function openReview(file, { title, open = false, reopen = false, sourceFile, pr, generation } = {}) {
  file = path.resolve(file);
  const review = await prepareReview(file, { reopen });
  if (review.ended) return review;
  if (title === undefined) {
    const html = await readFile(file, 'utf8');
    title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1].trim() || path.basename(file);
  }
  if (process.env.HC_TERMINAL_ID) await recordTarget(file, { title, sourceFile, pr, generation });
  const worker = await ensureRelay(await realpath(file));
  const { url, registered } = await presentReview(file, review.url, { title, open });
  console.log(worker.delivery
    ? `Feedback is delivered automatically; do not poll ${file}.`
    : `Feedback requires agent polling: lavish-axi poll ${quote(file)}.`);
  return { url, registered, delivery: worker.delivery };
}
