import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { saveDocument, textHash } from './save.mjs';
import { parsePR } from './pr-format.mjs';

const maxMetadata = 16 * 1024;
const builtins = new Set(['commits', 'changes', 'tasks', 'pr']);

export function validateMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Metadata must be a JSON object');
  for (const [key, item] of Object.entries(value)) {
    if (!['reviewedRepository', 'baseCommit', 'headCommit', 'sourceUrl'].includes(key) || typeof item !== 'string') throw new Error('Invalid metadata field');
    if (key === 'reviewedRepository' && !item.trim()) throw new Error('Invalid reviewed repository');
    if ((key === 'baseCommit' || key === 'headCommit') && !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(item)) throw new Error('Invalid full commit ID');
    if (key === 'sourceUrl') {
      let url;
      try { url = new URL(item); } catch { throw new Error('Invalid source URL'); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid source URL');
    }
  }
  return value;
}

export async function readMetadata(file) {
  const handle = await open(file, 'r');
  try {
    const data = Buffer.alloc(maxMetadata + 1);
    let size = 0;
    while (size < data.length) {
      const { bytesRead } = await handle.read(data, size, data.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxMetadata) throw new Error('Metadata exceeds 16 KiB');
    return validateMetadata(JSON.parse(data.subarray(0, size).toString('utf8')));
  } finally { await handle.close(); }
}

export async function createHubDocuments(directory, { guardSource = async () => {} } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stateFile = path.join(directory, 'documents.json');
  let state;
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { documents: {}, attachments: {} }; }
  for (const kind of ['tasks', 'pr']) {
    const file = path.join(directory, `${kind}.md`);
    try { await writeFile(file, '', { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    state.attachments[kind] ||= { source: file, version: randomUUID() };
  }
  let serial = Promise.resolve();
  const locked = fn => { const result = serial.then(fn); serial = result.catch(() => {}); return result; };
  async function persist(next) {
    const temp = `${stateFile}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(next), { flag: 'wx', mode: 0o600 }); await rename(temp, stateFile); state = next; }
    finally { await rm(temp, { force: true }); }
  }
  async function source(file, extensions) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Source must be an absolute path');
    const resolved = await realpath(file);
    if (!extensions.includes(path.extname(resolved).toLowerCase()) || !(await stat(resolved)).isFile()) throw new Error('Unsupported source file');
    return resolved;
  }
  const lookup = id => {
    if (typeof id !== 'string') return undefined;
    const entries = builtins.has(id) ? state.attachments : state.documents;
    return Object.hasOwn(entries, id) ? entries[id] : undefined;
  };
  return {
    list: () => ({ documents: Object.values(state.documents), attachments: { ...state.attachments } }),
    publish: body => locked(async () => {
      if (typeof body.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(body.id) || builtins.has(body.id)) throw new Error('Invalid document ID');
      if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 512)) throw new Error('Invalid document title');
      const file = await source(body.file, ['.md', '.markdown', '.html']);
      const metadata = body.metadata === undefined ? {} : validateMetadata(body.metadata);
      if (Buffer.byteLength(JSON.stringify(metadata)) > maxMetadata) throw new Error('Metadata exceeds 16 KiB');
      const document = { id: body.id, title: body.title || path.basename(file), source: file, metadata, version: randomUUID() };
      await persist({ ...state, documents: { ...state.documents, [body.id]: document } });
      return document;
    }),
    attach: body => locked(async () => {
      if (!['tasks', 'pr'].includes(body.kind)) throw new Error('Invalid attachment');
      if (!body.file && (body.kind !== 'pr' || body.rev === undefined)) throw new Error('An attachment file or PR revision is required');
      let attachment = state.attachments[body.kind];
      if (body.file) {
        const file = await source(body.file, ['.md', '.markdown']);
        if (body.kind === 'pr') parsePR(await readFile(file, 'utf8'));
        attachment = { source: file, version: randomUUID() };
      }
      if (body.kind === 'pr' && body.rev !== undefined) attachment = { ...attachment, rev: body.rev };
      else if (body.kind === 'pr') attachment = { ...attachment, ...(state.attachments.pr.rev ? { rev: state.attachments.pr.rev } : {}) };
      await persist({ ...state, attachments: { ...state.attachments, [body.kind]: attachment } });
      return attachment;
    }),
    savePrForLaunch: body => locked(async () => {
      const target = lookup('pr');
      if (!target || body.version !== target.version) throw new Error('Document target changed; reload before launching');
      parsePR(body.text);
      const saved = await saveDocument({ baseHash: body.baseHash, text: body.text }, { sourceFile: target.source });
      if (saved.reply !== 'Saved') throw new Error(`${saved.reply} PR command was not launched.`);
      return { source: target.source, rev: target.rev || '@-', savedHash: textHash(body.text) };
    }),
    read: body => locked(async () => {
      const target = lookup(body.id);
      if (!target) throw new Error('Unknown document');
      await guardSource(target.source);
      const text = await readFile(target.source, 'utf8');
      return { ...target, text, hash: textHash(text) };
    }),
    save: body => locked(async () => {
      const target = lookup(body.id);
      if (!target || typeof body.version !== 'string' || body.version !== target.version) throw new Error('Document target changed; reload before saving');
      if (path.extname(target.source).toLowerCase() === '.html') throw new Error('HTML source editing is not supported');
      if (body.id === 'pr') parsePR(body.text);
      return saveDocument({ baseHash: body.baseHash, text: body.text }, { sourceFile: target.source });
    }),
  };
}
