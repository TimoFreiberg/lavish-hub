import { execFileSync } from 'node:child_process';
import { mkdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const vendor = path.join(root, 'vendor/lavish');
const link = path.join(vendor, 'node_modules');
await mkdir(path.join(root, 'dist'), { recursive: true });
execFileSync(process.execPath, ['build.mjs', root, path.join(root, 'dist')], { cwd: root, stdio: 'inherit' });
await symlink(path.join(root, 'node_modules'), link, 'dir');
try {
  execFileSync(process.execPath, ['scripts/build.js'], { cwd: vendor, stdio: 'inherit', env: { ...process.env, LAVISH_AXI_UMAMI_HOST: '', LAVISH_AXI_UMAMI_WEBSITE_ID: '' } });
} finally {
  await rm(link);
}
