import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { saveDocument, textHash } from './save.mjs';
import { HubError } from './hub-errors.mjs';

const invalid = (message, cause) => new HubError('VALIDATION_ERROR', 'fix_args', message, cause);

const maxMetadata = 16 * 1024;
const builtins = new Set(['commits', 'changes', 'tasks']);

export function deriveDocumentId(resolvedFile, existingDocuments) {
  let slug = path.basename(resolvedFile, path.extname(resolvedFile)).toLowerCase().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  if (!/^[a-zA-Z0-9]/.test(slug)) slug = `doc-${slug}`;
  if (builtins.has(slug)) slug += '-doc';
  slug = slug.slice(0, 64);
  if (Object.hasOwn(existingDocuments, slug) && existingDocuments[slug].source !== resolvedFile) {
    slug = `${slug.slice(0, 55)}-${createHash('sha256').update(resolvedFile).digest('hex').slice(0, 8)}`;
    if (Object.hasOwn(existingDocuments, slug) && existingDocuments[slug].source !== resolvedFile) throw invalid('Derived document ID is already used by another source; pass --id');
  }
  return slug;
}

export function validateMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Metadata must be a JSON object');
  for (const [key, item] of Object.entries(value)) {
    if (!['reviewedRepository', 'baseCommit', 'headCommit', 'sourceUrl'].includes(key) || typeof item !== 'string') throw invalid('Invalid metadata field');
    if (key === 'reviewedRepository' && !item.trim()) throw invalid('Invalid reviewed repository');
    if ((key === 'baseCommit' || key === 'headCommit') && !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(item)) throw invalid('Invalid full commit ID');
    if (key === 'sourceUrl') {
      let url;
      try { url = new URL(item); } catch { throw invalid('Invalid source URL'); }
      if (!['http:', 'https:'].includes(url.protocol)) throw invalid('Invalid source URL');
    }
  }
  return value;
}

export async function readMetadata(file) {
  let handle;
  try { handle = await open(file, 'r'); }
  catch (error) { throw invalid(`Cannot read metadata file: ${error.message}`, error); }
  try {
    const data = Buffer.alloc(maxMetadata + 1);
    let size = 0;
    while (size < data.length) {
      const { bytesRead } = await handle.read(data, size, data.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxMetadata) throw invalid('Metadata exceeds 16 KiB');
    return validateMetadata(JSON.parse(data.subarray(0, size).toString('utf8')));
  } catch (error) {
    if (error instanceof HubError) throw error;
    throw invalid(`Cannot read metadata file: ${error.message}`, error);
  } finally { await handle.close(); }
}

export async function createHubDocuments(directory, { guardSource = async () => {} } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stateFile = path.join(directory, 'documents.json');
  let state;
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { documents: {}, attachments: {} }; }
  for (const doc of Object.values(state.documents || {})) {
    if (doc && typeof doc === 'object') {
      delete doc.attention;
      if (!Object.hasOwn(doc, 'viewedVersion')) doc.viewedVersion = doc.version ?? null;
    }
  }
  const file = path.join(directory, 'tasks.md');
  try { await writeFile(file, '', { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  state.attachments = { tasks: state.attachments.tasks || { source: file, version: randomUUID() } };
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
    refreshPublished: generate => locked(() => generate(Object.values(state.documents))),
    publish: (body, generate = async (_documents, commit) => commit()) => locked(async () => {
      if (body.id !== undefined && (typeof body.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(body.id) || builtins.has(body.id))) throw new Error('Invalid document ID');
      if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 512)) throw new Error('Invalid document title');
      let file;
      try { file = await source(body.file, ['.md', '.markdown', '.html']); }
      catch (error) { if (error.code === 'ENOENT') throw invalid(`Source file not found: ${body.file}`, error); throw error; }
      const existing = Object.values(state.documents).find(doc => doc.source === file);
      const id = body.id === undefined ? (existing?.id ?? deriveDocumentId(file, state.documents)) : body.id;
      const metadata = body.metadata === undefined ? {} : validateMetadata(body.metadata);
      if (Buffer.byteLength(JSON.stringify(metadata)) > maxMetadata) throw new Error('Metadata exceeds 16 KiB');
      const previous = Object.hasOwn(state.documents, id) ? state.documents[id] : null;
      const viewedVersion = previous && Object.hasOwn(previous, 'viewedVersion') ? previous.viewedVersion : null;
      const document = { id, title: body.title || path.basename(file), source: file, metadata, version: randomUUID(), publishedAt: new Date().toISOString(), viewedVersion };
      const next = { ...state, documents: { ...state.documents, [id]: document } };
      await generate(Object.values(next.documents), () => persist(next), id);
      return document;
    }),
    acknowledge: body => locked(async () => {
      const id = body?.id, version = body?.version;
      if (typeof id !== 'string' || typeof version !== 'string' || !version || !Object.hasOwn(state.documents, id)) return false;
      const current = state.documents[id];
      if (current.version !== version) return false;
      if (current.viewedVersion === version) return false;
      const next = { ...state, documents: { ...state.documents, [id]: { ...current, viewedVersion: version } } };
      await persist(next);
      return true;
    }),
    attach: body => locked(async () => {
      if (body.kind !== 'tasks') throw new Error('Invalid attachment');
      if (!body.file) throw new Error('An attachment file is required');
      const file = await source(body.file, ['.md', '.markdown']);
      const attachment = { source: file, version: randomUUID() };
      await persist({ ...state, attachments: { ...state.attachments, tasks: attachment } });
      return attachment;
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
      await guardSource(target.source);
      return saveDocument({ baseHash: body.baseHash, text: body.text }, { sourceFile: target.source });
    }),
  };
}
