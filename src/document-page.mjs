import { cp, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { atomicWrite } from './files.mjs';
import { textHash } from './save.mjs';
import { publishPageData } from './page-data.mjs';

export function documentOutputPath(source, out, kind = 'markdown') {
  return out ? path.resolve(out) : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'lavish-kit/pages', kind, `${path.basename(source, path.extname(source))}-${textHash(source).slice(0, 10)}`, 'index.html');
}
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
export async function publishDocument(file, source, { sourceName = source } = {}) {
  const bytes = await readFile(source), hash = textHash(bytes);
  await publishPageData(path.dirname(file), hash, { sourceFile: sourceName, text: bytes.toString('utf8'), hash });
  return hash;
}
export async function writeDocumentShell(file, dist, title, app, pr, { bootstrap = '' } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  await cp(dist, path.join(path.dirname(file), 'assets'), { recursive: true, force: true });
  const metadata = pr ? `<script>globalThis.lavishViewPR=${JSON.stringify(pr).replaceAll('<', '\\u003c')};</script>` : '';
  await atomicWrite(file, `<!doctype html>\n<html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><link rel="stylesheet" href="./assets/document.css"></head><body><main id="app"></main>${metadata}${bootstrap ? `<script src="${escape(bootstrap)}"></script>` : ''}<script src="./assets/${app}-app.js"></script></body></html>\n`);
}
export async function writeTaskPage(source, dist, { out, title, deps, sourceName, bootstrap } = {}) {
  source = await realpath(source);
  const file = documentOutputPath(source, out);
  if (!title && deps) title = await (await import('./markdown.mjs')).markdownTitle(await readFile(source, 'utf8'), deps);
  title ||= path.basename(source);
  await writeDocumentShell(file, dist, title, 'task', undefined, { bootstrap });
  const hash = await publishDocument(file, source, { sourceName });
  return { file, source, title, hash };
}
