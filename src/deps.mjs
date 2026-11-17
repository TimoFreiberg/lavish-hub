import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { packageRoot } from './runtime.mjs';

export async function ensureDeps({ root = packageRoot } = {}) {
  const dist = path.join(root, 'dist');
  try { await access(path.join(dist, 'hub-markdown.js')); }
  catch { throw new Error('Hub assets missing; build the package for development'); }
  const require = createRequire(path.join(root, 'package.json'));
  return { deps: root, dist, require, resolve: name => require.resolve(name) };
}
