import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { runtimeEnv } from './runtime.mjs';

export const supportedLavishVersion = '0.1.97';
const keyFor = file => createHash('sha256').update(file).digest('hex').slice(0, 16);
const failure = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

// Opening a page still uses the CLI, which owns server startup and networking.
export function createLavishClient({ env = process.env, fetch: request = globalThis.fetch, signal } = {}) {
  env = runtimeEnv(env);
  const version = supportedLavishVersion;
  const port = Number(env.LAVISH_AXI_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid LAVISH_AXI_PORT');
  const base = `http://127.0.0.1:${port}`;
  const directory = path.resolve(env.LAVISH_AXI_STATE_DIR);
  const stateFile = path.join(directory, 'state.json');
  const boundedSignal = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  async function json(url, options = {}) {
    const response = await request(url, { redirect: 'error', ...options });
    const data = await response.json();
    if (!response.ok || data.code === 'LISTENER_REPLACED') {
      throw Object.assign(failure(data.code || (response.status === 404 ? 'NOT_FOUND' : 'LAVISH_HTTP_ERROR'), data.error || data.status || `HTTP ${response.status}`), { status: response.status });
    }
    return data;
  }
  async function verify() {
    const health = await json(`${base}/health`, { signal: boundedSignal() });
    if (!health.ok || health.app !== 'lavish-axi' || health.version !== version || health.lavish_kit_page_reviews !== 1) {
      throw failure('UNSUPPORTED_LAVISH', `Direct HTTP requires patched lavish-axi ${version}; server reports ${health.version || 'unknown'}`);
    }
    const canonicalDirectory = await realpath(directory);
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
        if (error.cause?.code === 'ECONNREFUSED') return null;
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
      const data = await json(`${base}/api/poll?${query}`, { signal });
      if (data.status === 'missing') throw failure('NOT_FOUND', 'No active Lavish session for this file');
      if (!['feedback', 'ended', 'waiting', 'browser_disconnected'].includes(data.status)) throw failure('LAVISH_PROTOCOL_ERROR', 'Unknown poll status');
      return {
        session: { file: absolute, status: data.status, ...(data.session_ended ? { session_ended: true } : {}), ...(data.ended_by ? { ended_by: data.ended_by } : {}) },
        ...(data.status === 'feedback' ? { prompts: data.prompts || [], dom_snapshot: data.dom_snapshot || '', ...(Object.hasOwn(data, 'snapshot_page') ? { snapshot_page: data.snapshot_page } : {}), ...(data.artifact_failures?.length ? { artifact_failures: data.artifact_failures } : {}) } : {}),
      };
    },
    async registerHub(file, transport) {
      const absolute = await realpath(file);
      const port = Number(new URL(transport.url).port);
      await verify();
      try {
        await json(`${base}/api/hub-proxy/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: keyFor(absolute), port, capability: transport.capability, resourceKey: transport.resourceKey, identityKey: transport.identityKey }), signal: boundedSignal() });
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
    async reply(file, text) {
      if (!text.trim()) throw new Error('Agent reply must not be empty');
      const absolute = await realpath(file);
      return post(`/api/${keyFor(absolute)}/agent-reply`, { text });
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
  const mode = (options.env || process.env).LAVISH_KIT_LAVISH_TRANSPORT || 'http';
  if (!['http', 'cli'].includes(mode)) throw new Error('LAVISH_KIT_LAVISH_TRANSPORT must be http or cli');
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
