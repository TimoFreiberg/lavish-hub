import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHubTransport } from './hub-transport.mjs';
import { createHubJj, isWorkingCopyRev, resolveTargetRev } from './hub-jj.mjs';
import { createHubDocuments } from './hub-documents.mjs';
import { createHubCommands } from './hub-commands.mjs';
import { resolveWorkspace, resolveRecordedWorkspace, resolveHubSession, resolveRecordedSession, resolveSessionId, primaryRootForRepo, repoMatches, checkoutMatchesRepo, recordWorkspace, workspaceMatches } from './hub-workspace.mjs';
import { computeHubUrl } from './hub-url.mjs';
import { prepareReview, presentReview } from './lavish.mjs';
import { createLavishClient } from './lavish-http.mjs';
import { HubError } from './hub-errors.mjs';
import { ensureHubAssets } from './deps.mjs';
import { composeHubHtml, renderSiblingNavigation } from './hub-html.mjs';
import { themeCss } from './orangebox.mjs';
import { createTitleResolver, validateSessionTitle } from './hub-title.mjs';

export { validateSessionTitle };

const startup = 'Start one with lavish-hub listen --workspace DIR';
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
async function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
export async function resolveHubIdentity(options = {}) {
  const env = options.env || process.env;
  const session = resolveSessionId(options, env);
  const live = dir => session ? resolveHubSession(dir, session, env) : resolveWorkspace(dir, env);
  const recorded = dir => session ? resolveRecordedSession(dir, session, env) : resolveRecordedWorkspace(dir, env);
  let current;
  try { current = await live(options.workspace); }
  catch (error) {
    if (!options.workspace) throw error;
    try { return await recorded(options.workspace); } catch { throw error; }
  }
  // Preserve recorded identity if a checkout path was replaced.
  try { return await recorded(current.root); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return current; }
}

export function formatNotificationBatch(batch, { identity, instance, page, selected, documents, siblingSources }) {
  const selectedDoc = documents.find(doc => doc.id === selected);
  const docFields = selectedDoc ? { id: selectedDoc.id, document: selectedDoc.source } : {};
  const prompts = batch.prompts.map(prompt => {
    const target = prompt.target;
    const sibling = siblingSources.get(prompt.page);
    const artifact = target?.type === 'diff-line' ? { kind: 'diff', view: 'changes' }
      : sibling ? { kind: 'document', id: sibling.id, document: sibling.source }
        : { kind: prompt.tag === 'message' ? 'freeform' : 'hub', view: selected, ...docFields };
    let message = prompt.prompt;
    let diff;
    if (target?.type === 'diff-line') {
      const match = typeof message === 'string' && message.match(/^Hub view: [^\n]+\nRevision range: ([^\n]+)\n\n[^\n]+\n\n([\s\S]*?)\n\n([\s\S]*)$/);
      if (match) message = match[3];
      diff = { file: target.newPath || target.oldPath, oldPath: target.oldPath, side: target.side, startLine: target.start, endLine: target.end, revision: target.revision, ...(match?.[1] ? { range: match[1] } : {}), ...(match?.[2] ? { quote: match[2] } : {}) };
    }
    const element = Object.fromEntries(['uid', 'tag', 'selector', 'text'].filter(key => prompt[key] !== undefined).map(key => [key, prompt[key]]));
    return { message, artifact, ...(diff ? { diff } : {}), ...(target?.type === 'text-range' ? { selection: { text: target.text } } : target && target.type !== 'diff-line' ? { target } : {}), ...(target?.type !== 'diff-line' && prompt.tag !== 'message' && Object.keys(element).length ? { element } : {}), ...(prompt.attachments?.length ? { attachments: prompt.attachments } : {}) };
  });
  const snapshotDocument = siblingSources.get(batch.snapshot_page)?.source ?? null;
  return { type: 'agent-notification', batchId: batch.batch_id ?? null, workspace: identity.root, ...(identity.session ? { session: identity.session } : {}), instance, page, prompts, hasDomContext: Boolean(batch.dom_snapshot), failures: batch.artifact_failures || [], ...(!prompts.length && snapshotDocument ? { snapshotDocument } : {}) };
}

async function checkInvocationCheckout(identity, directory) {
  const matches = identity.session
    ? await repoMatches(identity) && await checkoutMatchesRepo(directory, identity)
    : await workspaceMatches(identity);
  if (!matches) throw new Error('Workspace is unavailable or has changed');
}

async function readTarget(directory) {
  let target;
  try { target = await readJson(path.join(directory, 'target.json')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some(key => !['rev', 'base', 'title'].includes(key))) throw new Error('Invalid target record');
  for (const key of ['rev', 'base']) {
    if (target[key] === undefined) continue;
    const rev = target[key];
    if (!rev || typeof rev !== 'object' || Array.isArray(rev) || Object.keys(rev).some(k => !['input', 'revset', 'kind', 'changeId'].includes(k)) || typeof rev.input !== 'string' || !rev.input.trim() || typeof rev.revset !== 'string' || !rev.revset.trim() || isWorkingCopyRev(rev.revset) || /[\x00-\x1f\x7f]/.test(rev.input + rev.revset) || !['change', 'bookmark', 'remote-bookmark', 'revset'].includes(rev.kind) || (rev.kind === 'change' ? !/^[a-z]{32}$/.test(rev.changeId || '') || rev.revset !== `change_id(${rev.changeId})` : rev.changeId !== undefined)) throw new Error('Invalid target record');
  }
  if (target.title !== undefined && validateSessionTitle(target.title) !== target.title) throw new Error('Invalid target record');
  return target;
}

export async function prepareTargetRequest(options = {}) {
  const body = {};
  if (['rev', 'base'].some(key => options[key] !== undefined && isWorkingCopyRev(options[key]))) {
    await checkInvocationCheckout(await resolveHubIdentity(options), options.workspace || process.cwd());
  }
  for (const key of ['rev', 'base']) {
    if (options[key] !== undefined) body[key] = isWorkingCopyRev(options[key]) ? (await resolveTargetRev(options.workspace || process.cwd(), options[key])).changeId : options[key];
  }
  if (options.noBase) body.clearBase = true;
  if (options.title !== undefined) body.title = options.title;
  return body;
}

async function acquire(identity, instance) {
  await mkdir(identity.directory, { recursive: true, mode: 0o700 });
  const lock = path.join(identity.directory, 'owner');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const claim = path.join(lock, 'reclaim');
    try { await mkdir(claim, { mode: 0o700 }); }
    catch { throw new Error('Hub ownership is busy or another owner is starting'); }
    try {
      let previous;
      try { previous = await readJson(path.join(lock, 'owner.json')); }
      catch { throw new Error('Hub ownership cannot be verified; refusing takeover'); }
      if (alive(previous.pid)) throw new Error('A hub owner is already running for this workspace');
      await atomicJson(path.join(lock, 'owner.json'), { pid: process.pid, instance });
      await rm(path.join(lock, 'runtime.json'), { force: true });
    } finally { await rm(claim, { recursive: true, force: true }); }
    return lock;
  }
  await atomicJson(path.join(lock, 'owner.json'), { pid: process.pid, instance });
  return lock;
}
async function release(lock, instance) {
  try {
    const owner = await readJson(path.join(lock, 'owner.json'));
    if (owner.instance === instance && owner.pid === process.pid) await rm(lock, { recursive: true, force: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function runHubOwner(options = {}, { prepare = prepareReview } = {}) {
  const startedAt = Date.now();
  const identity = await resolveHubIdentity(options);
  if (identity.session && options.rev === undefined) throw new Error('listen with --session requires --rev');
  const title = options.title === undefined ? undefined : validateSessionTitle(options.title);
  const primaryRoot = primaryRootForRepo(identity.repo), repoName = path.basename(primaryRoot);
  const instance = randomUUID();
  const lock = await acquire(identity, instance);
  const abort = new AbortController();
  let transport, commands, registeredPage, stopping = false;
  const generatedSiblings = new Set();
  const siblingContents = new Map();
  const recordFile = path.join(identity.directory, 'generated-documents.json');
  const hashes = new Map();
  const digest = content => createHash('sha256').update(content).digest('hex');
  const saveHashes = () => atomicJson(recordFile, Object.fromEntries(hashes));
  const stop = () => { stopping = true; abort.abort(); };
  const signals = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) process.once(signal, stop);
  try {
    let currentTarget = await readTarget(identity.directory);
    const titleResolver = options.titleResolver || createTitleResolver({ env: options.env });
    let providerTitle = null;
    const refreshProviderTitle = async () => {
      try { providerTitle = await titleResolver.resolve({ session: identity.session, workspaceRoot: identity.root, primaryRoot }); }
      catch { providerTitle = null; }
    };
    const effectiveTitle = () => currentTarget.title || providerTitle || null;
    const isDetached = () => Boolean(identity.session || currentTarget.rev);
    const isAvailable = () => isDetached() ? repoMatches(identity) : workspaceMatches(identity);
    const repoOk = await repoMatches(identity);
    if (!repoOk && (options.rev !== undefined || options.base !== undefined)) throw new Error('Repository is unavailable or has changed');
    if (repoOk) {
      const invocationDir = options.workspace || process.cwd();
      const resolveStartup = async value => {
        if (!isWorkingCopyRev(value)) return resolveTargetRev(primaryRoot, value, { ignoreWorkingCopy: true });
        await checkInvocationCheckout(identity, invocationDir);
        return resolveTargetRev(invocationDir, value);
      };
      const next = { ...currentTarget };
      if (options.rev !== undefined) next.rev = await resolveStartup(options.rev);
      if (options.base !== undefined) next.base = await resolveStartup(options.base);
      if (options.noBase) delete next.base;
      if (title !== undefined) next.title = title;
      if (JSON.stringify(next) !== JSON.stringify(currentTarget)) await atomicJson(path.join(identity.directory, 'target.json'), next);
      currentTarget = next;
    }
    let recorded = {};
    try { recorded = await readJson(recordFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded)) throw new Error('Invalid generated document ownership record');
    const recovered = [];
    for (const [name, values] of Object.entries(recorded)) {
      if (!/^document-[a-f0-9]{64}\.html$/.test(name) || !Array.isArray(values) || !values.length || values.some(value => !/^[a-f0-9]{64}$/.test(value))) throw new Error('Invalid generated document ownership record');
      hashes.set(name, values);
      const target = path.join(identity.directory, name);
      const current = await readFile(target, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (current !== null && !values.includes(digest(current))) throw new Error(`Published document ${name} was edited; refusing to overwrite it`);
      if (current !== null) recovered.push({ target, current });
    }
    for (const { target, current } of recovered) { generatedSiblings.add(target); siblingContents.set(target, current); }
    if (!(await isAvailable())) console.error('Workspace is unavailable or has changed; repository actions are disabled.');
    await recordWorkspace(identity);
    const page = path.join(identity.directory, 'hub.html');
    const canonicalPage = await realpath(page).catch(async error => {
      if (error.code !== 'ENOENT') throw error;
      return path.join(await realpath(identity.directory), 'hub.html');
    });
    const sessionKey = createHash('sha256').update(canonicalPage).digest('hex').slice(0, 16);
    const browserUrl = `/hub-proxy/${sessionKey}`;
    const jj = createHubJj(() => isDetached() ? primaryRoot : identity.root, { target: currentTarget, validate: isAvailable });
    const guardSource = async file => {
      const withinWorkspace = candidate => {
        const relative = path.relative(identity.root, candidate);
        return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      };
      if (!(await workspaceMatches(identity))) {
        if (withinWorkspace(file)) throw new Error('Workspace is unavailable or has changed; source is unavailable');
        if (withinWorkspace(await realpath(file))) throw new Error('Workspace is unavailable or has changed; source is unavailable');
      }
    };
    const documents = await createHubDocuments(identity.directory, { guardSource });
    commands = await createHubCommands(identity.directory, () => isDetached() ? primaryRoot : identity.root, isAvailable);
    let reviewUrl;
    const workspaceName = path.basename(identity.root);
    const directUrl = id => reviewUrl ? `${reviewUrl}?view=${encodeURIComponent(id)}` : undefined;
    const siblingSources = new Map();
    const recentBatches = new Map();
    const siblingName = doc => `document-${createHash('sha256').update(JSON.stringify([doc.id, doc.source])).digest('hex')}.html`;
    const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    const confirmNavigation = await readFile(new URL('../web/confirm-navigation.js', import.meta.url), 'utf8');
    async function writeSiblings(docs = documents.list().documents, commit = async () => {}, requiredId = null) {
      const htmlDocs = docs.filter(doc => doc.source.toLowerCase().endsWith('.html'));
      const staged = [];
      const previousHashes = new Map(hashes);
      try {
      for (const doc of htmlDocs) {
        if (requiredId !== null && doc.id !== requiredId) continue;
        let authored;
        try { await guardSource(doc.source); authored = await readFile(doc.source, 'utf8'); }
        catch (error) {
          if (doc.id === requiredId) throw error;
          console.error(`Document source is unavailable for ${doc.id}: ${error.message}`);
          continue;
        }
        const base = `${browserUrl}/resources/${transport.resourceKey}/${encodeURIComponent(doc.id)}/${encodeURIComponent(path.basename(doc.source))}`;
        const destinations = [...Object.entries({ commits: 'Commits', changes: 'Changes', tasks: 'Tasks' }).map(([id, title]) => ({ id, title, href: `hub.html?__lavish_hub_view=${encodeURIComponent(id)}`, unseen: false })), ...docs.map(item => ({ id: item.id, title: item.title, href: item.source.toLowerCase().endsWith('.html') ? siblingName(item) : `hub.html?__lavish_hub_view=${encodeURIComponent(item.id)}`, unseen: item.id !== doc.id && item.viewedVersion !== item.version }))];
        const scope = Object.entries(doc.metadata || {}).map(([key, value]) => `<div><strong>${escapeHtml(key)}:</strong> ${escapeHtml(value)}</div>`).join('');
        const reviewedScope = scope ? `<aside aria-label="Reviewed scope">${scope}</aside>` : '';
        const navConfig = JSON.stringify({ url: browserUrl, capability: transport.capability, id: doc.id, version: doc.version, workspaceName, repoName, session: Boolean(identity.session), sessionTitle: effectiveTitle() || '' }).replaceAll('<', '\\u003c');
        const navigation = renderSiblingNavigation({ destinations, doc, sessionTitle: effectiveTitle() || '', identity, repoName, workspaceName, reviewedScope, confirmNavigation, navConfig });
        authored = composeHubHtml(authored, base, navigation);
        const name = siblingName(doc);
        const target = path.join(identity.directory, name);
        const previous = siblingContents.get(target);
        const current = await readFile(target, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (current !== null && current !== previous) throw new Error(`Published document ${doc.id} already exists or was edited; refusing to overwrite it`);
        const temp = `${target}.${randomUUID()}.tmp`;
        staged.push({ target, temp, current, authored, name, id: doc.id, source: doc.source, installed: false });
        await writeFile(temp, authored, { mode: 0o600, flag: 'wx' });
      }
      for (const item of staged) {
        hashes.set(item.name, [...new Set([...(item.current === null ? [] : [digest(item.current)]), digest(item.authored)])]);
      }
      await saveHashes();
      for (const item of staged) {
        await rename(item.temp, item.target);
        item.installed = true;
      }
      await commit();
      for (const item of staged) {
        generatedSiblings.add(item.target);
        siblingContents.set(item.target, item.authored);
        siblingSources.set(item.name, { id: item.id, source: item.source });
      }
      } catch (error) {
        hashes.clear();
        for (const [name, values] of previousHashes) hashes.set(name, values);
        for (const item of staged.filter(item => item.installed).reverse()) {
          if (item.current === null) await rm(item.target, { force: true });
          else {
            await writeFile(item.temp, item.current, { mode: 0o600, flag: 'wx' });
            await rename(item.temp, item.target);
          }
        }
        throw error;
      } finally {
        await Promise.all(staged.map(item => rm(item.temp, { force: true })));
      }
    }
    let selected = 'commits', selectionRevision = 0, selectionTarget = null;
    const hasView = id => ['commits', 'changes', 'tasks'].includes(id) || documents.list().documents.some(doc => doc.id === id);
    const select = (id, notify = false) => {
      if (!hasView(id)) throw new Error('Unknown view');
      selected = id;
      if (notify) { selectionTarget = id; selectionRevision++; }
      return { selected, selectionRevision };
    };
    let register, targetSerial = Promise.resolve();
    transport = await createHubTransport({
      context: ({ batchId }) => {
        const batch = recentBatches.get(batchId);
        if (!batch) throw new HubError('BATCH_CONTEXT_UNAVAILABLE', 'refresh', 'Batch context is unavailable; refresh the review and request feedback again');
        return batch;
      },
      navigate: body => select(body.id),
      select: body => select(body.id, true),
      acknowledge: async body => {
        const acknowledged = await documents.acknowledge(body);
        if (acknowledged && register) await register({ refreshSummary: false }).catch(error => console.error(`Hub registration failed: ${error.message}`));
        return acknowledged;
      },
      open: async (body = {}) => {
        if (!reviewUrl) throw new Error('Hub review is not ready');
        if (body.view !== undefined && !hasView(body.view)) throw new Error('Unknown view');
        const target = body.view ? directUrl(body.view) : reviewUrl;
        return presentReview(page, target, { open: true, log: console.error });
      },
      executeCommand: body => commands.execute(body),
      commandStatus: body => commands.status(body),
      cancelCommand: body => commands.cancel(body),
      documents: () => { const list = documents.list(); return { ...list, documents: list.documents.map(doc => ({ ...doc, sibling: siblingName(doc) })) }; },
      publish: async body => {
        if (body.autoScope === true) {
          try { body = { ...body, metadata: { reviewedRepository: repoName, ...await jj.scope() } }; }
          catch { throw new HubError('WORKSPACE_UNAVAILABLE', 'refresh', 'Cannot determine review scope; pass --no-scope or explicit scope flags'); }
        }
        const document = await documents.publish(body, (docs, commit, id) => writeSiblings(docs, commit, id));
        if (register) await register({ refreshSummary: false }).catch(error => console.error(`Hub registration failed: ${error.message}`));
        return { ...document, scope: Object.keys(document.metadata || {}).length ? document.metadata : null, ...(reviewUrl ? { url: directUrl(document.id) } : {}) };
      },
      attach: body => documents.attach(body),
      readDocument: body => documents.read(body),
      saveDocument: async body => {
        if (!(await isAvailable())) throw new Error('Workspace is unavailable or has changed; saving is disabled');
        return documents.save(body);
      },
      target: body => {
        const update = targetSerial.then(async () => {
          const keys = Object.keys(body).filter(key => key !== 'operation');
          if (!keys.length || keys.some(key => !['rev', 'base', 'clearBase', 'title'].includes(key)) || ['rev', 'base', 'title'].some(key => body[key] !== undefined && typeof body[key] !== 'string') || (body.clearBase !== undefined && typeof body.clearBase !== 'boolean') || (body.base !== undefined && body.clearBase)) throw new Error('Invalid target request');
          const needsRepo = body.rev !== undefined || body.base !== undefined || body.clearBase !== undefined;
          if (needsRepo && !(await repoMatches(identity))) throw new Error('Repository is unavailable or has changed');
          if (!(needsRepo && isDetached()) && !(await isAvailable())) throw new Error('Workspace is unavailable or has changed');
          const next = { ...currentTarget };
          if (body.rev !== undefined) next.rev = await resolveTargetRev(primaryRoot, body.rev, { ignoreWorkingCopy: true });
          if (body.base !== undefined) next.base = await resolveTargetRev(primaryRoot, body.base, { ignoreWorkingCopy: true });
          if (body.clearBase) delete next.base;
          if (body.title !== undefined) next.title = validateSessionTitle(body.title);
          await atomicJson(path.join(identity.directory, 'target.json'), next);
          currentTarget = next;
          jj.setTarget(next);
          if (body.title !== undefined) {
            await documents.refreshPublished(writeSiblings).catch(error => console.error(`Published document refresh failed: ${error.message}`));
            if (register) await register().catch(error => console.error(`Hub registration failed: ${error.message}`));
          }
          return { target: next.rev?.input ?? null, base: next.base?.input ?? null, title: next.title ?? null };
        });
        targetSerial = update.catch(() => {});
        return update;
      },
      status: async () => ({ workspace: identity.root, repoName, ...(identity.session ? { session: identity.session } : {}), ...(effectiveTitle() ? { title: effectiveTitle() } : {}), ...(currentTarget.rev ? { target: currentTarget.rev.input } : {}), ...(currentTarget.base ? { base: currentTarget.base.input } : {}), instance, selected, selectionRevision, selectionTarget, ...(reviewUrl ? { url: reviewUrl } : {}), available: await isAvailable() }),
      snapshot: ({ force, knownVersion }) => jj.snapshot({ force: force === true, knownVersion }),
      diffFiles: body => jj.diffFiles(body),
      describe: body => jj.describe(body),
      stop: async () => { setImmediate(stop); return { stopping: true }; },
    }, { resource: id => documents.list().documents.find(doc => doc.id === id)?.source, guardSource });
    const web = new URL('../web/', import.meta.url);
    const dist = await ensureHubAssets();
    const [script, style, diffScript, diffStyle, markdownScript, documentStyle] = await Promise.all([readFile(new URL('hub-app.mjs', web), 'utf8'), readFile(new URL('hub.css', web), 'utf8'), readFile(path.join(dist, 'diff-app.js'), 'utf8'), readFile(path.join(dist, 'diff.css'), 'utf8'), readFile(path.join(dist, 'hub-markdown.js'), 'utf8'), readFile(path.join(dist, 'document.css'), 'utf8')]);
    await refreshProviderTitle();
    await writeSiblings();
    const config = JSON.stringify({ url: browserUrl, capability: transport.capability, resourceKey: transport.resourceKey, workspace: identity.root, workspaceName, repoName, session: Boolean(identity.session), sessionTitle: effectiveTitle() || '' }).replaceAll('<', '\\u003c');
    async function asset(content, extension) {
      const name = `hub-asset-${digest(content)}.${extension}`;
      const target = path.join(identity.directory, name);
      const temp = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, content, { mode: 0o600, flag: 'wx' });
        await rename(temp, target);
      } finally { await rm(temp, { force: true }); }
      return name;
    }
    const [cssAsset, diffAsset, markdownAsset, appAsset] = await Promise.all([
      asset(`${themeCss}\n${style}\n@scope (.hub-diff) { ${diffStyle} } @scope (.hub-markdown) { ${documentStyle} }`, 'css'),
      asset(diffScript, 'js'), asset(markdownScript, 'js'), asset(script, 'js'),
    ]);
    transport.assets = [diffAsset, markdownAsset, appAsset];
    // Media references stay unloaded until requested and export as data URLs without executing scripts.
    const html = `<!doctype html><html lang="en" data-theme="orangebox"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(effectiveTitle() || repoName)}</title><link rel="stylesheet" href="${cssAsset}"></head><body><div id="app"></div><script>${confirmNavigation}</script><script>globalThis.hubConfig=${config};</script><audio preload="none" data-hub-bundle="diff" src="${diffAsset}"></audio><audio preload="none" data-hub-bundle="markdown" src="${markdownAsset}"></audio><script src="${appAsset}"></script></body></html>`;
    await writeFile(page, html, { mode: 0o600 });
    await chmod(page, 0o600);
    const review = await prepare(page, { reopen: options.reopen, log: console.error, vendored: true });
    if (review.ended) return 1;
    reviewUrl = review.url;
    const client = createLavishClient({ signal: abort.signal, vendored: true });
    let lastSummary = null, registerSerial = Promise.resolve();
    register = ({ refreshSummary = true } = {}) => {
      const run = registerSerial.then(async () => {
        if (refreshSummary) {
          await refreshProviderTitle();
          lastSummary = await jj.summary().catch(() => null);
        }
        const title = effectiveTitle();
        const unread = documents.list().documents.filter(doc => doc.viewedVersion !== doc.version).slice(0, 50).map(doc => ({ id: doc.id, title: Array.from(String(doc.title ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() || doc.id).slice(0, 255).join('') }));
        return client.registerHub(page, transport, {
          label: Array.from(title || workspaceName).slice(0, 255).join(''),
          repo: Array.from(repoName).slice(0, 255).join(''),
          workspace: identity.session || title ? null : 'workspace',
          startedAt,
          summary: lastSummary,
          unread,
        });
      });
      registerSerial = run.catch(() => {});
      return run;
    };
    if (!(await register())) return 0;
    registeredPage = page;
    await atomicJson(path.join(lock, 'runtime.json'), { pid: process.pid, instance, url: transport.url, capability: transport.capability, page });
    await presentReview(page, review.url, { open: options.open, log: console.error });
    console.error(`Hub owner running for ${identity.root}; stop with lavish-hub stop.`);
    while (!stopping) {
      if (!(await register())) break;
      const batch = await client.poll(page, instance, { timeoutMs: 10000 });
      if (batch.session.status === 'feedback') {
        const batchId = batch.batch_id ?? null;
        const snapshotPage = batch.snapshot_page ?? null;
        recentBatches.delete(batchId);
        recentBatches.set(batchId, { batchId, domSnapshot: batch.dom_snapshot || '', snapshotPage, snapshotDocument: siblingSources.get(snapshotPage)?.source ?? null });
        while (recentBatches.size > 50) recentBatches.delete(recentBatches.keys().next().value);
        console.log(JSON.stringify(formatNotificationBatch(batch, { identity, instance, page, selected, documents: documents.list().documents, siblingSources })));
      }
      if (batch.session.status === 'ended' || batch.session.session_ended) break;
    }
    return 0;
  } catch (error) {
    if (stopping && (error.name === 'AbortError' || abort.signal.aborted)) return 0;
    if (error?.ambiguousDelivery) {
      console.error('Feedback poll failed with an uncertain delivery outcome; Lavish may already have consumed a batch and marked it Seen in the review chat. Check the review chat or ask the reviewer to resend before restarting lavish-hub listen.');
    }
    throw error;
  } finally {
    for (const signal of signals) process.removeListener(signal, stop);
    if (commands) commands.close();
    if (registeredPage && transport) {
      try { await createLavishClient({ vendored: true }).unregisterHub(registeredPage, transport); }
      catch (error) { console.error(`Hub proxy cleanup failed: ${error.message}`); }
    }
    if (transport) await transport.close();
    await Promise.all([...generatedSiblings].map(async file => {
      const current = await readFile(file, 'utf8').catch(() => null);
      if (current !== null && current === siblingContents.get(file)) await rm(file, { force: true });
    }));
    await release(lock, instance);
  }
}

export async function callHub(operation, options = {}) {
  const identity = await resolveHubIdentity(options);
  let runtime;
  try { runtime = await readJson(path.join(identity.directory, 'owner', 'runtime.json')); }
  catch { throw new HubError('NO_OWNER', 'reconnect', `No live hub owner. ${startup}`); }
  if (!alive(runtime.pid) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.url) || !/^[a-f0-9]{64}$/.test(runtime.capability || '')) throw new HubError('NO_OWNER', 'reconnect', `No live hub owner. ${startup}`);
  let response;
  try {
    response = await fetch(`${runtime.url}/action`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lavish-capability': runtime.capability }, body: JSON.stringify({ ...options.body, operation }), signal: AbortSignal.timeout(15000), redirect: 'error' });
  } catch (error) { throw new HubError('OWNER_UNREACHABLE', 'reconnect', `Hub owner ${error.name === 'TimeoutError' ? 'timed out' : 'is unreachable'}; it will not be replaced automatically. ${startup}`, error); }
  const data = await response.json();
  if (!response.ok) {
    if (data.code && data.action) throw new HubError(data.code, data.action, data.error || 'Hub request failed');
    throw Object.assign(new Error(data.error || 'Hub request failed'), data.code ? { code: data.code } : {});
  }
  return data.result;
}

export async function hubUrl(options = {}, deps = {}) {
  const identity = await resolveHubIdentity(options);
  try {
    const status = await callHub('status', options);
    if (status?.url) return status.url;
  } catch (error) {
    if (error.code !== 'NO_OWNER') throw error;
  }
  return computeHubUrl(identity, { env: options.env, ...deps });
}
