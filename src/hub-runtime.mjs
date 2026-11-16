import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHubTransport } from './hub-transport.mjs';
import { createHubJj } from './hub-jj.mjs';
import { createHubDocuments } from './hub-documents.mjs';
import { createHubCommands } from './hub-commands.mjs';
import { createHubPr } from './hub-pr.mjs';
import { resolveWorkspace, resolveRecordedWorkspace, recordWorkspace, workspaceMatches } from './hub-workspace.mjs';
import { prepareReview, presentReview } from './lavish.mjs';
import { createLavishClient } from './lavish-http.mjs';
import { quote } from './relay.mjs';
import { ensureDeps } from './deps.mjs';

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
  try { return await resolveWorkspace(dir); }
  catch (error) {
    if (!dir) throw error;
    try { return await resolveRecordedWorkspace(dir); } catch { throw error; }
  }
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

export async function runHubOwner(options = {}) {
  const identity = await workspace(options.workspace);
  const instance = randomUUID();
  const lock = await acquire(identity, instance);
  const abort = new AbortController();
  let transport, commands, stopping = false;
  const stop = () => { stopping = true; abort.abort(); };
  const signals = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) process.once(signal, stop);
  try {
    if (!(await workspaceMatches(identity))) throw new Error('Workspace no longer matches its recorded repository');
    await recordWorkspace(identity);
    const page = path.join(identity.directory, 'hub.html');
    const jj = createHubJj(identity.root, { validate: () => workspaceMatches(identity) });
    const documents = await createHubDocuments(identity.directory);
    commands = await createHubCommands(identity.directory, identity.root, () => workspaceMatches(identity));
    const launchPr = await createHubPr(identity.directory, identity.root, documents, jj);
    let selected = 'commits';
    const select = id => {
      if (!['commits', 'changes', 'tasks', 'pr'].includes(id) && !documents.list().documents.some(doc => doc.id === id)) throw new Error('Unknown view');
      selected = id;
      return { selected };
    };
    transport = await createHubTransport({
      navigate: body => select(body.id),
      launchPr,
      configurePr: async body => { if (body.rev !== undefined) await jj.prHead(body.rev); return documents.attach({ ...body, kind: 'pr' }); },
      executeCommand: body => commands.execute(body),
      commandStatus: body => commands.status(body),
      cancelCommand: body => commands.cancel(body),
      documents: () => documents.list(),
      publish: async body => { const document = await documents.publish(body); select(document.id); return document; },
      attach: body => documents.attach(body),
      readDocument: body => documents.read(body),
      saveDocument: body => documents.save(body),
      status: async () => ({ workspace: identity.root, instance, selected, available: await workspaceMatches(identity) }),
      snapshot: () => jj.snapshot(),
      describe: body => jj.describe(body),
      stop: async () => { setImmediate(stop); return { stopping: true }; },
    }, { resource: id => documents.list().documents.find(doc => doc.id === id)?.source });
    const web = new URL('../web/', import.meta.url);
    const { dist } = await ensureDeps();
    const [script, style, diffScript, diffStyle, markdownScript, documentStyle] = await Promise.all([readFile(new URL('hub-app.mjs', web), 'utf8'), readFile(new URL('hub.css', web), 'utf8'), readFile(path.join(dist, 'diff-app.js'), 'utf8'), readFile(path.join(dist, 'diff.css'), 'utf8'), readFile(path.join(dist, 'hub-markdown.js'), 'utf8'), readFile(path.join(dist, 'document.css'), 'utf8')]);
    const config = JSON.stringify({ url: transport.url, capability: transport.capability, resourceKey: transport.resourceKey, workspace: identity.root }).replaceAll('<', '\\u003c');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workspace hub</title><style>${style}\n@scope (.hub-diff) { ${diffStyle} } @scope (.hub-markdown) { ${documentStyle} }</style></head><body><div id="app"></div><script>globalThis.hubConfig=${config};</script><script>${diffScript.replaceAll('</script', '<\\/script')}</script><script>${markdownScript.replaceAll('</script', '<\\/script')}</script><script type="module">${script}</script></body></html>`;
    await writeFile(page, html, { mode: 0o600 });
    await chmod(page, 0o600);
    const review = await prepareReview(page, { reopen: options.reopen, log: console.error });
    if (review.ended) return 1;
    const client = createLavishClient({ signal: abort.signal });
    await atomicJson(path.join(lock, 'runtime.json'), { pid: process.pid, instance, url: transport.url, capability: transport.capability, page });
    await presentReview(page, review.url, { title: 'Workspace hub', open: options.open, log: console.error });
    console.error(`Hub owner running for ${identity.root}; stop with lavish-kit hub stop.`);
    while (!stopping) {
      const batch = await client.poll(page, instance, { timeoutMs: 10000 });
      if (batch.session.status === 'feedback') {
        console.log(JSON.stringify({ type: 'agent-notification', workspace: identity.root, instance, page, prompts: batch.prompts, context: batch.dom_snapshot, failures: batch.artifact_failures || [], reply: `lavish-axi reply ${quote(page)} --agent-reply '...'` }));
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
    if (transport) await transport.close();
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
