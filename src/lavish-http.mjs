import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalPath } from './hub-workspace.mjs';
import { quote } from './quote.mjs';
import { lavishCli, runtimeEnv } from './runtime.mjs';
import { resolveLavishPort } from './lavish-port.mjs';
import { HubError } from './hub-errors.mjs';

export const supportedLavishVersion = '0.1.98';
// Local vendor patches this client cannot work without, named by the /health field
// that reports each one. The vendored server keeps its upstream release number, so
// a process started from an earlier build of it reports the supported version and
// every older field: only a field it predates separates that process from a
// supported one.
const requiredPatches = [
  ['lavish_hub_page_reviews', 'the page review routes'],
  ['lavish_hub_assets', 'the hub asset origin grant'],
  ['lavish_hub_batch_replies', 'batch-bound agent replies'],
];
const keyFor = file => createHash('sha256').update(file).digest('hex').slice(0, 16);
const failure = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

// A server that only predates a patch keeps running on this process's port and state
// directory, so the shutdown that replaces it has to name both. The package puts no
// `lavish-axi` on PATH: the only CLI is the vendored one, reachable by path. Paths and
// directories can hold spaces or quotes, so they are shell-quoted to be pasted as is.
export function stopCommand({ cli = lavishCli, directory, port }) {
  return `LAVISH_AXI_STATE_DIR=${quote(directory)} LAVISH_AXI_PORT=${port} node ${quote(cli)} stop`;
}

// Opening a page still uses the CLI, which owns server startup and networking.
export function createLavishClient({ env = process.env, fetch: request = globalThis.fetch, signal, portResolved = false } = {}) {
  const inputEnv = env;
  env = runtimeEnv(env);
  const version = supportedLavishVersion;
  let port, base;
  const directory = path.resolve(env.LAVISH_AXI_STATE_DIR);
  const stateFile = path.join(directory, 'state.json');
  const boundedSignal = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  async function json(url, options = {}) {
    let response;
    try { response = await request(url, { redirect: 'error', ...options }); }
    catch (error) {
      if (!error.cause?.code) throw error;
      throw Object.assign(failure('LAVISH_CONNECTION_ERROR', `Cannot connect to Lavish at ${base} (${error.cause.code}). Check that the server is running and that LAVISH_AXI_PORT is correct.`), { cause: error.cause });
    }
    const data = await response.json();
    if (!response.ok || data.code === 'LISTENER_REPLACED') {
      throw Object.assign(failure(data.code || (response.status === 404 ? 'NOT_FOUND' : 'LAVISH_HTTP_ERROR'), data.error || data.status || `HTTP ${response.status}`), { status: response.status, data });
    }
    return data;
  }
  async function verify() {
    if (port === undefined) {
      port = portResolved ? Number(env.LAVISH_AXI_PORT) : await resolveLavishPort(inputEnv);
      base = `http://127.0.0.1:${port}`;
    }
    let health;
    try { health = await json(`${base}/health`, { signal: boundedSignal() }); }
    catch (error) {
      if (error.cause?.code === 'ECONNREFUSED') { port = undefined; base = undefined; }
      if (error.name === 'TimeoutError') throw new HubError('LAVISH_CONNECTION_ERROR', 'reconnect', 'Lavish health check timed out', error);
      throw error;
    }
    if (!health.ok || health.app !== 'lavish-axi' || health.version !== version) {
      throw failure('UNSUPPORTED_LAVISH', `Direct HTTP requires patched lavish-axi ${version}; server reports ${health.version || 'unknown'}`);
    }
    const missing = requiredPatches.filter(([field]) => health[field] !== 1).map(([, patch]) => patch);
    if (missing.length) {
      // The version matches, so the CLI adopts this server rather than replacing it:
      // only ending the process makes the next command start this build. An operator
      // reaches that through the CLI that owns server shutdown, with the state
      // directory and port this process uses.
      throw failure('UNSUPPORTED_LAVISH', `The running lavish-axi ${version} server predates this build and lacks ${missing.join(' and ')}; shut that server down with the packaged CLI and retry: ${stopCommand({ directory, port })}`);
    }
    const canonicalDirectory = await canonicalPath(directory);
    const stateId = keyFor(path.join(canonicalDirectory, 'state.json'));
    if (health.state_id !== stateId) throw failure('LAVISH_STATE_MISMATCH', 'Server uses a different Lavish state directory');
    return health;
  }
  async function post(endpoint, body) {
    await verify();
    return json(`${base}${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: boundedSignal() });
  }
  return {
    async verifyIfRunning() {
      try { return await verify(); }
      catch (error) {
        if (error.cause?.code === 'ECONNREFUSED') { port = undefined; base = undefined; return null; }
        throw error;
      }
    },
    async poll(file, owner, { timeoutMs } = {}) {
      await verify();
      const absolute = await realpath(file);
      const query = new URLSearchParams({ file: absolute, owner });
      if (timeoutMs !== undefined) query.set('timeoutMs', String(timeoutMs));
      // Never retry a consuming request: a truncated response has an unknown
      // delivery outcome.
      let data;
      try {
        data = await json(`${base}/api/poll?${query}`, { signal });
      } catch (error) {
        const nonConsuming = error?.name === 'AbortError' || ['LISTENER_ACTIVE', 'LISTENER_REPLACED', 'NOT_FOUND', 'VALIDATION_ERROR'].includes(error?.code);
        if (!nonConsuming && error && typeof error === 'object') error.ambiguousDelivery = true;
        throw error;
      }
      if (data.status === 'missing') throw failure('NOT_FOUND', 'No active Lavish session for this file');
      if (!['feedback', 'ended', 'waiting', 'browser_disconnected'].includes(data.status)) {
        throw Object.assign(failure('LAVISH_PROTOCOL_ERROR', 'Unknown poll status'), { ambiguousDelivery: true });
      }
      return {
        session: { file: absolute, status: data.status, ...(data.session_ended ? { session_ended: true } : {}), ...(data.ended_by ? { ended_by: data.ended_by } : {}) },
        ...(data.status === 'feedback' ? { batch_id: data.batch_id ?? null, prompts: data.prompts || [], dom_snapshot: data.dom_snapshot || '', ...(Object.hasOwn(data, 'snapshot_page') ? { snapshot_page: data.snapshot_page } : {}), ...(data.artifact_failures?.length ? { artifact_failures: data.artifact_failures } : {}) } : {}),
      };
    },
    async registerHub(file, transport, display) {
      const absolute = await realpath(file);
      const port = Number(new URL(transport.url).port);
      await verify();
      try {
        await json(`${base}/api/hub-proxy/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: keyFor(absolute), port, capability: transport.capability, resourceKey: transport.resourceKey, identityKey: transport.identityKey, assets: transport.assets, display }), signal: boundedSignal() });
        return true;
      } catch (error) {
        if (error.code === 'HUB_SESSION_ENDED' && error.status === 404 && error.message === 'HUB_SESSION_ENDED: Session not active') return false;
        throw error;
      }
    },
    async unregisterHub(file, transport) {
      const absolute = await realpath(file);
      return post('/api/hub-proxy/unregister', { key: keyFor(absolute), identityKey: transport.identityKey });
    },
    async reply(file, text, { batchId } = {}) {
      if (!text.trim()) throw new HubError('VALIDATION_ERROR', 'fix_args', 'Agent reply must not be empty');
      let absolute;
      try { absolute = await realpath(file); }
      catch (error) {
        if (error.code === 'ENOENT') throw new HubError('NOT_FOUND', 'reconnect', 'No Lavish hub session exists for this workspace; start lavish-hub listen first', error);
        throw error;
      }
      await verify();
      try {
        return await json(`${base}/api/${keyFor(absolute)}/agent-reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, ...(batchId ? { batch_id: batchId } : {}) }), signal: boundedSignal() });
      } catch (error) {
        if (error.status === 409 && error.data?.status === 'ended') throw new HubError('SESSION_ENDED', 'reconnect', error.data.error || 'Lavish session ended', error);
        if (error.status === 409 && error.code === 'BATCH_ALREADY_REPLIED') throw new HubError('BATCH_ALREADY_REPLIED', 'check_delivery', `${error.data.error || 'Batch already replied'}${error.data.replied_at ? ` (replied at ${error.data.replied_at})` : ''}`, error);
        if (error.status === 404 && error.code === 'BATCH_NOT_FOUND') throw new HubError('BATCH_NOT_FOUND', 'fix_args', error.data.error || 'Batch not found', error);
        if (!error.status) throw new HubError('REPLY_DELIVERY_UNCERTAIN', 'check_delivery', 'Reply delivery is uncertain; check the review chat before retrying', error);
        throw error;
      }
    },
    async end(file) { return post('/api/end', { file: await realpath(file) }); },
    async list() {
      // There is no HTTP listing endpoint in 0.1.96. Like its no-argument CLI,
      // read the store without consuming feedback or starting/reopening a server.
      let state;
      try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return { sessions: [] }; throw error; }
      if (!state.sessions || typeof state.sessions !== 'object' || Array.isArray(state.sessions)) throw new Error('Invalid Lavish session store');
      const sessions = Object.values(state.sessions);
      if (sessions.some(session => !session || typeof session.file !== 'string' || typeof session.status !== 'string')) throw new Error('Invalid Lavish session record');
      const active = sessions.filter(session => session.status !== 'ended');
      if (active.length) await verify();
      return { sessions: active.map(({ file, status }) => ({ file, status })) };
    },
  };
}

export function lavishHttpRun({ run, encode, ...options }) {
  const mode = (options.env || process.env).LAVISH_HUB_LAVISH_TRANSPORT || 'http';
  if (!['http', 'cli'].includes(mode)) throw new Error('LAVISH_HUB_LAVISH_TRANSPORT must be http or cli');
  if (mode === 'cli') return run;
  const client = createLavishClient(options);
  return async (name, args) => {
    if (name !== 'lavish-axi') return run(name, args);
    let result;
    if (!args.length) result = await client.list();
    else if (args[0] === 'poll' && args.length === 4 && args[2] === '--owner') result = await client.poll(args[1], args[3]);
    else if (args[0] === 'reply' && args.length === 4 && args[2] === '--agent-reply') result = await client.reply(args[1], args[3]);
    else if (args[0] === 'end' && args.length === 2) result = await client.end(args[1]);
    else return run(name, args);
    return { stdout: encode(result), stderr: '' };
  };
}
