import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';

const limit = 64 * 1024;
const allowedHeaders = new Set(['content-type', 'x-lavish-capability']);

// The caller owns the capability and must keep it out of URLs and logs.
export async function createHubTransport(operations, { resource, guardSource = async () => {} } = {}) {
  const capability = randomBytes(32).toString('hex');
  const resourceKey = randomBytes(32).toString('hex');
  const identityKey = randomBytes(32).toString('hex');
  let diagnosticId = 0;
  const server = http.createServer(async (req, res) => {
    if (process.env.LAVISH_HUB_DIAGNOSTICS === '1') {
      const id = ++diagnosticId, start = Date.now(), method = req.method;
      const log = (event, status) => {
        try { console.error(JSON.stringify({ diagnostic: 'hub', side: 'owner', id, method, event, time: new Date().toISOString(), elapsedMs: Date.now() - start, ...(status === undefined ? {} : { status }) })); } catch {}
      };
      log('arrive');
      res.once('finish', () => log('finish', res.statusCode));
      res.once('close', () => log('close', res.statusCode));
    }
    const respond = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(req.headers.origin === 'null' ? { 'access-control-allow-origin': 'null', vary: 'Origin' } : {}) });
      res.end(JSON.stringify(value));
    };
    const address = server.address();
    if (req.headers.host !== `127.0.0.1:${address.port}` || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return respond(403, { error: 'Invalid host' });
    if (req.headers.origin && req.headers.origin !== 'null') return respond(403, { error: 'Invalid origin' });
    if (req.method === 'GET' && /^\/identity\/[a-f0-9]{64}$/.test(req.url) && !req.headers.origin && !req.headers.referer) {
      const challenge = req.url.slice('/identity/'.length);
      return respond(200, { proof: createHmac('sha256', identityKey).update(challenge).digest('hex') });
    }
    if (req.method === 'GET' && resource && req.url.startsWith(`/resources/${resourceKey}/`)) {
      try {
        const parts = new URL(req.url, 'http://127.0.0.1').pathname.split('/');
        const id = decodeURIComponent(parts[3]);
        const file = await resource(id);
        if (!file) throw new Error('Not found');
        await guardSource(file);
        const root = await realpath(path.dirname(file));
        const relative = parts.slice(4).map(decodeURIComponent).join('/');
        const requested = path.resolve(root, relative);
        await guardSource(requested);
        const target = await realpath(requested);
        await guardSource(target);
        const within = path.relative(root, target);
        if (!within || within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within) || !(await stat(target)).isFile()) throw new Error('Not found');
        const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2' };
        const data = await readFile(target);
        res.writeHead(200, { 'content-type': types[path.extname(target).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store', 'access-control-allow-origin': 'null', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
        return res.end(data);
      } catch { return respond(404, { error: 'Resource not found' }); }
    }
    if (req.method === 'OPTIONS') {
      const headers = (req.headers['access-control-request-headers'] || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
      if (req.headers.origin !== 'null' || req.headers['access-control-request-method'] !== 'POST' || headers.some(header => !allowedHeaders.has(header))) return respond(403, { error: 'Invalid preflight' });
      res.writeHead(204, { 'access-control-allow-origin': 'null', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type, x-lavish-capability', 'cache-control': 'no-store', vary: 'Origin' });
      return res.end();
    }
    const supplied = Buffer.from(req.headers['x-lavish-capability'] || '');
    const expected = Buffer.from(capability);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return respond(403, { error: 'Unauthorized' });
    if (req.method !== 'POST' || req.url !== '/action' || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return respond(400, { error: 'Invalid request' });
    let size = 0, chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) return respond(413, { error: 'Request too large' });
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || Array.isArray(body) || typeof body !== 'object' || typeof body.operation !== 'string' || !Object.hasOwn(operations, body.operation)) return respond(400, { error: 'Unknown operation' });
      const result = await operations[body.operation](body);
      respond(200, { result });
    } catch (error) {
      if (!res.headersSent) respond(400, { error: error instanceof Error ? error.message : 'Action failed' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, capability, resourceKey, identityKey, close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
