import { access } from 'node:fs/promises';
import path from 'node:path';
import { packageRoot } from './runtime.mjs';

export async function ensureHubAssets({ root = packageRoot } = {}) {
  const dist = path.join(root, 'dist');
  try { await access(path.join(dist, 'hub-markdown.js')); }
  catch { throw new Error('Hub assets missing; build the package for development'); }
  return dist;
}
