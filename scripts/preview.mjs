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
if ((await readdir(out)).length) {
  let previous;
  try { previous = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(out, 'manifest.json'), 'utf8')); } catch {}
  if (previous?.generator !== 'lavish-kit-preview' || !Array.isArray(previous.pages)) throw new Error(`Preview output directory is not a generated preview: ${out}`);
  for (const name of ['assets', ...previous.pages.map(page => page.id)]) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid generated preview manifest');
    await rm(path.join(out, name), { recursive: true, force: true });
  }
}
const scratch = await mkdtemp(path.join(os.tmpdir(), 'lavish-preview-'));
try {
  const dist = path.join(scratch, 'dist'); await mkdir(dist);
  execFileSync(process.execPath, [path.join(root, 'build.mjs'), root, dist], { stdio: 'inherit' });
  const assets = path.join(out, 'assets'); await mkdir(assets);
  await cp(path.join(dist, 'preview.js'), path.join(assets, 'preview.js'));
  for (const [source, target] of [
    ['node_modules/daisyui/daisyui.css', 'daisyui.css'],
    ['node_modules/daisyui/themes.css', 'themes.css'],
    ['node_modules/@tailwindcss/browser/dist/index.global.js', 'tailwind.js'],
  ]) await cp(path.join(root, source), path.join(assets, target));
  const diff = await scratchDiff(scratch);
  const pages = [];
  for (const variant of variants) {
    const id = variantId(variant), dir = path.join(scratch, id); await mkdir(dir);
    await makePage(variant, dir, dist, diff, { portable: true });
    await cp(path.join(dir, 'page'), path.join(out, id, 'page'), { recursive: true });
    pages.push({ ...variant, id, url: `${id}/page/index.html` });
  }
  const dirty = Boolean(execFileSync('jj', ['diff', '--summary', '-r', '@'], { cwd: root, encoding: 'utf8' }).trim());
  const manifest = { generator: 'lavish-kit-preview', version: 1, fixtureVersion: version, revision, dirty, timestamp, pages };
  await writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const links = pages.map(page => `<li><a href="${page.url}">${page.id}</a></li>`).join('\n');
  await writeFile(path.join(out, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview fixtures</title></head><body><h1>Preview fixtures</h1><p>Development preview; not published. Simulated interactions do not save files or run actions.</p><p>Fixture version ${version}; source revision ${revision}${dirty ? ' (working change modified)' : ''}; built ${timestamp}.</p><ul>${links}</ul><p><a href="manifest.json">Manifest</a></p><script>const theme=new URL(location.href).searchParams.get('theme'); if(theme==='light') document.querySelectorAll('li a').forEach(a=>a.search='?theme=light');</script></body></html>\n`);
  console.log(`Preview generated: ${out}`);
} finally { await rm(scratch, { recursive: true, force: true }); }
