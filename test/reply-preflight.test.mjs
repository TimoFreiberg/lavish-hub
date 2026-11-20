import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { lavishCli } from '../src/runtime.mjs';

const cli = path.resolve('bin/lavish-kit');
function run(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
    child.stdin.end('input remains available\n');
  });
}

test('reply refuses incompatible servers before side effects and forwards compatible replies', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reply-preflight-'));
  const page = path.join(dir, 'page with spaces.html');
  await writeFile(page, '<p>test</p>');
  const stateId = createHash('sha256').update(path.join(await realpath(dir), 'state.json')).digest('hex').slice(0, 16);
  const requests = [];
  let compatible = false;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/health')) res.end(JSON.stringify({ ok: true, app: 'lavish-axi', version: compatible ? '0.1.97' : '0.1.96', lavish_kit_page_reviews: 1, lavish_kit_hub_assets: 1, state_id: stateId }));
    else res.end(JSON.stringify({ status: 'sent' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const env = { ...process.env, LAVISH_AXI_STATE_DIR: dir, LAVISH_AXI_PORT: String(server.address().port) };
  const text = 'spaces, "quotes", $characters\nsecond line';
  const args = ['reply', page, '--agent-reply', text];
  const rejected = await run(cli, args, env);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /UNSUPPORTED_LAVISH/);
  assert.equal(rejected.stdout, '');
  assert.ok(requests.length > 0);
  assert.ok(requests.every(({ method, url }) => method === 'GET' && url === '/health'));
  compatible = true;
  requests.length = 0;
  const direct = await run(lavishCli, args, env);
  const directRequests = requests.filter(request => request.method === 'POST');
  requests.length = 0;
  const wrapped = await run(cli, args, env);
  assert.deepEqual(wrapped, direct);
  assert.equal(wrapped.status, 0, wrapped.stderr);
  const posts = requests.filter(request => request.method === 'POST');
  assert.deepEqual(posts, directRequests);
  assert.equal(JSON.parse(posts[0].body).text, text);
});
