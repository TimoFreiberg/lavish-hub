import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { lavishCli, runtimeEnv } from './runtime.mjs';

import { createLavishClient } from './lavish-http.mjs';
import { recordLavishPort, resolveLavishPort, withLavishStartupLock } from './lavish-port.mjs';

const exec = promisify(execFile);

export async function prepareReview(file, { reopen = false, log = console.log, resolvePort = resolveLavishPort, client = createLavishClient, run = exec } = {}) {
  file = path.resolve(file);
  let result;
  result = await withLavishStartupLock(process.env, async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const port = await resolvePort(process.env, { locked: true });
      const env = { ...runtimeEnv(), LAVISH_AXI_PORT: String(port) };
      let launched = false;
      try {
        await client({ env, portResolved: true }).verifyIfRunning();
        await readFile(lavishCli, { flag: 'r' });
        await recordLavishPort(process.env, port);
        launched = true;
        return await run(process.execPath, [lavishCli, file, '--no-open', ...(reopen ? ['--reopen'] : [])], { env });
      } catch (error) {
        if (error.code === 'ENOENT') throw new Error('Vendored Lavish build missing; build the package for development');
        // Retry only if another listener actually took the selected port.
        if (!launched && !process.env.LAVISH_AXI_PORT && await resolvePort(process.env, { locked: true }) !== port) continue;
        if (error.code === 'UNSUPPORTED_LAVISH' || error.code === 'LAVISH_STATE_MISMATCH') throw error;
        throw new Error(error.stderr?.trim() || `lavish-axi failed: ${error.message}`);
      }
    }
    throw new Error('Could not start Lavish: ports changed during startup');
  });
  if (/^\s*status:\s*user-ended\s*$/m.test(result.stdout)) {
    log(`The user ended the Lavish review of ${file}; pass --reopen only if they ask to see it again.`);
    return { ended: true };
  }
  const url = result.stdout.match(/^\s*url:\s*"?(https?:\/\/[^"\s]+)"?\s*$/m)?.[1];
  if (!url) throw new Error(result.stderr?.trim() || 'lavish-axi printed no review URL');
  return { url };
}

export async function presentReview(file, url, { open = false, log = console.log } = {}) {
  file = path.resolve(file);
  if (open) {
    try { await exec(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]); }
    catch (error) { throw new Error(error.stderr?.trim() || `browser open failed: ${error.message}`); }
  }
  log(`Lavish review of ${file} ready: ${url}${open ? '' : ' (ask the user to open it)'}`);
  return { url };
}

