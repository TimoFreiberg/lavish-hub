import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const lavishCli = path.join(packageRoot, 'vendor', 'lavish', 'dist', 'cli.mjs');

export function runtimeEnv(env = process.env) {
  return {
    ...env,
    LAVISH_AXI_PORT: env.LAVISH_AXI_PORT || '4388',
    LAVISH_AXI_STATE_DIR: env.LAVISH_AXI_STATE_DIR || path.join(env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), '.local', 'state'), 'lavish-hub', 'lavish'),
  };
}
