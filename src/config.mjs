import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function configPath(env = process.env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'lavish-kit/config.json');
}

export async function readCreatePr({ env = process.env } = {}) {
  const file = configPath(env);
  const reason = `Set createPr to a nonempty argv array of strings in ${file}`;
  try {
    const config = JSON.parse(await readFile(file, 'utf8'));
    const argv = config?.createPr;
    if (!config || typeof config !== 'object' || Array.isArray(config) || !Array.isArray(argv) || !argv.length ||
        argv.some(value => typeof value !== 'string' || value.includes('\0')) || !argv[0].trim()) {
      return { reason };
    }
    return { argv };
  } catch (error) {
    return { reason: error.code === 'ENOENT' ? reason : `Cannot read valid config.json. ${reason}` };
  }
}
