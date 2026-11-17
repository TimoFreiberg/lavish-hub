import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHubTransport } from './hub-transport.mjs';
import { createHubJj } from './hub-jj.mjs';
import { createHubDocuments } from './hub-documents.mjs';
import { createHubCommands } from './hub-commands.mjs';
import { resolveWorkspace, resolveRecordedWorkspace, recordWorkspace, workspaceMatches } from './hub-workspace.mjs';
import { prepareReview, presentReview } from './lavish.mjs';
import { createLavishClient } from './lavish-http.mjs';
import { quote } from './quote.mjs';
import { ensureHubAssets } from './deps.mjs';
import { composeHubHtml } from './hub-html.mjs';
import { themeCss } from './orangebox.mjs';

const startup = 'Start one with lavish-kit hub listen --workspace DIR';
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
async function workspace(dir) {
  let current;
  try { current = await resolveWorkspace(dir); }
  catch (error) {
    if (!dir) throw error;
    try { return await resolveRecordedWorkspace(dir); } catch { throw error; }
  }
  // A checkout path may have been replaced since this hub was created. Keep
  // its recorded identity so actions cannot silently move to the new repo.
  try { return await resolveRecordedWorkspace(current.root); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return current; }
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
  const identity = await workspace(options.workspace);
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
    if (!(await workspaceMatches(identity))) console.error('Workspace is unavailable or has changed; repository actions are disabled.');
    await recordWorkspace(identity);
    const page = path.join(identity.directory, 'hub.html');
    const canonicalPage = await realpath(page).catch(async error => {
      if (error.code !== 'ENOENT') throw error;
      return path.join(await realpath(identity.directory), 'hub.html');
    });
    const sessionKey = createHash('sha256').update(canonicalPage).digest('hex').slice(0, 16);
    const browserUrl = `/hub-proxy/${sessionKey}`;
    const jj = createHubJj(identity.root, { validate: () => workspaceMatches(identity) });
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
    commands = await createHubCommands(identity.directory, identity.root, () => workspaceMatches(identity));
    let reviewUrl;
    const siblingSources = new Map();
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
        const destinations = [...Object.entries({ commits: 'Commits', changes: 'Changes', tasks: 'Tasks' }).map(([id, title]) => ({ id, title, href: 'hub.html' })), ...docs.map(item => ({ id: item.id, title: item.title, href: item.source.toLowerCase().endsWith('.html') ? siblingName(item) : 'hub.html' }))];
        const nav = `<style>html { padding-left: 200px; box-sizing: border-box; } #lavish-hub-sidebar { position: fixed; inset: 0 auto 0 0; width: 200px; box-sizing: border-box; z-index: 2147483647; overflow: auto; padding: 16px 10px; background: var(--ob-surface); color: var(--ob-fg); border-right: 1px solid var(--ob-border); font: 14px system-ui, sans-serif; } #lavish-hub-sidebar nav { display: flex; flex-direction: column; gap: 4px; } #lavish-hub-sidebar nav a { display: block; padding: 8px 10px; border-radius: 5px; color: var(--ob-fg); text-decoration: none; overflow-wrap: anywhere; } #lavish-hub-sidebar nav a:hover, #lavish-hub-sidebar nav a:focus-visible { background: var(--ob-raised); } #lavish-hub-sidebar nav a[aria-current] { color: var(--ob-orange); background: var(--ob-raised); } #lavish-hub-sidebar [role=status] { margin: 12px 10px; color: var(--ob-muted); } #lavish-hub-sidebar [role=status][data-error] { color: var(--ob-red); } #lavish-hub-sidebar aside { margin: 16px 10px; overflow-wrap: anywhere; color: var(--ob-muted); }</style><div id="lavish-hub-sidebar" data-lavish-action><nav aria-label="Hub navigation">${destinations.map(item => `<a href="${item.href}" data-hub-id="${escapeHtml(item.id)}"${item.id === doc.id ? ' aria-current="page"' : ''}>${escapeHtml(item.title)}</a>`).join('')}</nav><div role="status" aria-live="polite"></div>`;
        const scope = Object.entries(doc.metadata || {}).map(([key, value]) => `<div><strong>${escapeHtml(key)}:</strong> ${escapeHtml(value)}</div>`).join('');
        const reviewedScope = scope ? `<aside aria-label="Reviewed scope">${scope}</aside>` : '';
        const navConfig = JSON.stringify({ url: browserUrl, capability: transport.capability, id: doc.id }).replaceAll('<', '\\u003c');
        const navigation = `${nav}${reviewedScope}</div><script>${confirmNavigation}</script><script>{const c=${navConfig};c.url=new URL(c.url,location.href).href;let navigating=false,dirty=false,leaving=false,edits=0,navGeneration=0;for(const type of ['input','change'])document.addEventListener(type,e=>{if(e.isTrusted&&!e.target.closest('[data-lavish-action],[data-lavish-ui]')){dirty=true;edits++}},true);window.addEventListener('beforeunload',e=>{if(dirty&&!leaving){e.preventDefault();e.returnValue=''}});const action=async(operation,body={})=>{const r=await fetch(c.url+'/action',{method:'POST',headers:{'content-type':'application/json','x-lavish-capability':c.capability},body:JSON.stringify({...body,operation})});if(!r.ok)throw Error('Hub action failed');return(await r.json()).result};const nav=document.querySelector('#lavish-hub-sidebar nav');const feedback=document.querySelector('#lavish-hub-sidebar [role=status]');for(const a of nav.querySelectorAll('a'))a.href=new URL(a.getAttribute('href'),location.href).href;nav.addEventListener('click',async e=>{const a=e.target.closest('a[data-hub-id]');if(!a||!nav.contains(a))return;e.preventDefault();if(navigating||leaving)return;navigating=true;navGeneration++;feedback.removeAttribute('data-error');feedback.textContent='Opening '+a.textContent+'…';nav.setAttribute('aria-busy','true');try{let approved=false,approvedEdits=edits;if(dirty){approved=await globalThis.confirmDraftNavigation('Leaving discards unsaved document edits.');if(!approved)return}await action('navigate',{id:a.dataset.hubId});if((!approved||approvedEdits!==edits)&&dirty&&!(await globalThis.confirmDraftNavigation('Leaving discards unsaved document edits.')))return;leaving=true;location.href=a.href}catch{feedback.dataset.error='';feedback.textContent='Could not open '+a.textContent+'. Select it again to retry.'}finally{navigating=false;if(!leaving){nav.removeAttribute('aria-busy');if(!feedback.hasAttribute('data-error'))feedback.textContent=''}}});async function refresh(){const generation=navGeneration;try{const [state,list]=await Promise.all([action('status'),action('documents')]);const items=[...Object.entries({commits:'Commits',changes:'Changes',tasks:'Tasks'}).map(([id,title])=>({id,title})),...list.documents];const focused=nav.contains(document.activeElement)?document.activeElement:null;const existing=new Map([...nav.querySelectorAll('a[data-hub-id]')].map(a=>[a.dataset.hubId,a]));let next=nav.firstElementChild;for(const item of items){const a=existing.get(item.id)||document.createElement('a');existing.delete(item.id);a.dataset.hubId=item.id;if(a.textContent!==item.title)a.textContent=item.title;const href=new URL(item.source?.toLowerCase().endsWith('.html')?item.sibling:'hub.html',location.href).href;if(a.href!==href)a.href=href;if(item.id===c.id)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');if(a!==next)nav.insertBefore(a,next);next=a.nextElementSibling}for(const a of existing.values())a.remove();if(focused?.isConnected&&document.activeElement!==focused)focused.focus();if(generation===navGeneration&&!navigating&&!leaving&&!dirty&&state.selected!==c.id){const doc=list.documents.find(d=>d.id===state.selected);location.href=new URL(doc&&doc.source.toLowerCase().endsWith('.html')?doc.sibling:'hub.html',location.href).href;return}}catch{}setTimeout(refresh,2000)}setTimeout(refresh,2000)}</script>`;
        authored = composeHubHtml(authored, base, navigation);
        const name = siblingName(doc);
        const target = path.join(identity.directory, name);
        const previous = siblingContents.get(target);
        const current = await readFile(target, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (current !== null && current !== previous) throw new Error(`Published document ${doc.id} already exists or was edited; refusing to overwrite it`);
        const temp = `${target}.${randomUUID()}.tmp`;
        staged.push({ target, temp, current, authored, name, source: doc.source, installed: false });
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
        siblingSources.set(item.name, item.source);
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
    let selected = 'commits';
    const select = id => {
      if (!['commits', 'changes', 'tasks'].includes(id) && !documents.list().documents.some(doc => doc.id === id)) throw new Error('Unknown view');
      selected = id;
      return { selected };
    };
    transport = await createHubTransport({
      navigate: body => select(body.id),
      open: async () => { if (!reviewUrl) throw new Error('Hub review is not ready'); return presentReview(page, reviewUrl, { title: 'Workspace hub', open: true, log: console.error }); },
      executeCommand: body => commands.execute(body),
      commandStatus: body => commands.status(body),
      cancelCommand: body => commands.cancel(body),
      documents: () => { const list = documents.list(); return { ...list, documents: list.documents.map(doc => ({ ...doc, sibling: siblingName(doc) })) }; },
      publish: async body => { const document = await documents.publish(body, (docs, commit) => writeSiblings(docs, commit, body.id)); select(document.id); return document; },
      attach: body => documents.attach(body),
      readDocument: body => documents.read(body),
      saveDocument: async body => {
        if (!(await workspaceMatches(identity))) throw new Error('Workspace is unavailable or has changed; saving is disabled');
        return documents.save(body);
      },
      status: async () => ({ workspace: identity.root, instance, selected, available: await workspaceMatches(identity) }),
      snapshot: ({ force }) => jj.snapshot({ force: force === true }),
      describe: body => jj.describe(body),
      stop: async () => { setImmediate(stop); return { stopping: true }; },
    }, { resource: id => documents.list().documents.find(doc => doc.id === id)?.source, guardSource });
    const web = new URL('../web/', import.meta.url);
    const dist = await ensureHubAssets();
    const [script, style, diffScript, diffStyle, markdownScript, documentStyle] = await Promise.all([readFile(new URL('hub-app.mjs', web), 'utf8'), readFile(new URL('hub.css', web), 'utf8'), readFile(path.join(dist, 'diff-app.js'), 'utf8'), readFile(path.join(dist, 'diff.css'), 'utf8'), readFile(path.join(dist, 'hub-markdown.js'), 'utf8'), readFile(path.join(dist, 'document.css'), 'utf8')]);
    await writeSiblings();
    const config = JSON.stringify({ url: browserUrl, capability: transport.capability, resourceKey: transport.resourceKey, workspace: identity.root }).replaceAll('<', '\\u003c');
    const html = `<!doctype html><html lang="en" data-theme="orangebox"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workspace hub</title><style>${themeCss}\n${style}\n@scope (.hub-diff) { ${diffStyle} } @scope (.hub-markdown) { ${documentStyle} }</style></head><body><div id="app"></div><script>${confirmNavigation}</script><script>globalThis.hubConfig=${config};</script><script>${diffScript.replaceAll('</script', '<\\/script')}</script><script>${markdownScript.replaceAll('</script', '<\\/script')}</script><script type="module">${script}</script></body></html>`;
    await writeFile(page, html, { mode: 0o600 });
    await chmod(page, 0o600);
    const review = await prepare(page, { reopen: options.reopen, log: console.error, vendored: true });
    if (review.ended) return 1;
    reviewUrl = review.url;
    const client = createLavishClient({ signal: abort.signal, vendored: true });
    const register = () => client.registerHub(page, transport);
    if (!(await register())) return 0;
    registeredPage = page;
    await atomicJson(path.join(lock, 'runtime.json'), { pid: process.pid, instance, url: transport.url, capability: transport.capability, page });
    await presentReview(page, review.url, { title: 'Workspace hub', open: options.open, log: console.error });
    console.error(`Hub owner running for ${identity.root}; stop with lavish-kit hub stop.`);
    while (!stopping) {
      if (!(await register())) break;
      const batch = await client.poll(page, instance, { timeoutMs: 10000 });
      if (batch.session.status === 'feedback') {
        const sourceFor = sibling => siblingSources.get(sibling) ?? null;
        const prompts = batch.prompts.map(prompt => typeof prompt === 'object' && prompt !== null && sourceFor(prompt.page) ? { ...prompt, document: sourceFor(prompt.page) } : prompt);
        console.log(JSON.stringify({ type: 'agent-notification', workspace: identity.root, instance, page, prompts, context: batch.dom_snapshot, snapshotPage: batch.snapshot_page ?? null, snapshotDocument: sourceFor(batch.snapshot_page), failures: batch.artifact_failures || [], reply: `lavish-kit reply ${quote(page)} --agent-reply '...'` }));
      }
      if (batch.session.status === 'ended' || batch.session.session_ended) break;
    }
    return 0;
  } catch (error) {
    if (stopping && (error.name === 'AbortError' || abort.signal.aborted)) return 0;
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
  const identity = await workspace(options.workspace);
  let runtime;
  try { runtime = await readJson(path.join(identity.directory, 'owner', 'runtime.json')); }
  catch { throw new Error(`No live hub owner. ${startup}`); }
  if (!alive(runtime.pid) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.url) || !/^[a-f0-9]{64}$/.test(runtime.capability || '')) throw new Error(`No live hub owner. ${startup}`);
  let response;
  try {
    response = await fetch(`${runtime.url}/action`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lavish-capability': runtime.capability }, body: JSON.stringify({ ...options.body, operation }), signal: AbortSignal.timeout(3000), redirect: 'error' });
  } catch { throw new Error(`Hub owner is unreachable; it will not be replaced automatically. ${startup}`); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Hub request failed');
  return data.result;
}
