import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { variants, variantId, scratchDiff, makePage } from './visual/fixtures.mjs';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.argv[2] || path.join(root, 'preview'));
const timestamp = new Date(process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) * 1000 : Date.now()).toISOString();
const revision = execFileSync('jj', ['log', '-r', '@', '--no-graph', '-T', 'commit_id'], { cwd: root, encoding: 'utf8' }).trim();
const version = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'package.json'), 'utf8')).version;
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error(`Preview output directory must be empty: ${out}`);
const scratch = await mkdtemp(path.join(os.tmpdir(), 'lavish-preview-'));
try {
  const dist = path.join(scratch, 'dist'); await mkdir(dist);
  execFileSync(process.execPath, [path.join(root, 'build.mjs'), root, dist], { stdio: 'inherit' });
  const assets = path.join(out, 'assets'); await mkdir(assets);
  for (const [source, target] of [
    ['node_modules/daisyui/daisyui.css', 'daisyui.css'],
    ['node_modules/daisyui/themes.css', 'themes.css'],
    ['node_modules/@tailwindcss/browser/dist/index.global.js', 'tailwind.js'],
    ['scripts/visual/preview-readonly.js', 'preview.js'],
  ]) await cp(path.join(root, source), path.join(assets, target));
  const diff = await scratchDiff(scratch);
  const pages = [];
  for (const variant of variants) {
    const id = variantId(variant), dir = path.join(scratch, id); await mkdir(dir);
    await makePage(variant, dir, dist, diff, { portable: true });
    await cp(path.join(dir, 'page'), path.join(out, id, 'page'), { recursive: true });
    pages.push({ ...variant, id, url: `${id}/page/index.html` });
  }
  const manifest = { version: 1, fixtureVersion: version, revision, timestamp, pages };
  await writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const links = pages.map(page => `<li><a href="${page.url}">${page.id}</a></li>`).join('\n');
  await writeFile(path.join(out, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview fixtures</title></head><body><h1>Preview fixtures</h1><p>Development preview; not published. Interactive simulation is not yet available; no files are saved or actions run.</p><p>Fixture version ${version}; source revision ${revision}; built ${timestamp}.</p><ul>${links}</ul><p><a href="manifest.json">Manifest</a></p></body></html>\n`);
  console.log(`Preview generated: ${out}`);
} finally { await rm(scratch, { recursive: true, force: true }); }
