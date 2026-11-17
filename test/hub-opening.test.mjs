import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('vendored opening refuses an incompatible occupied port before registration', async t => {
  const calls = [];
  const server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, app: 'lavish-axi', version: '0.1.96' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const module = pathToFileURL(path.resolve('src/lavish.mjs')).href;
  const script = `import { prepareReview } from ${JSON.stringify(module)}; await prepareReview('page.html', { vendored: true });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, LAVISH_AXI_PORT: String(server.address().port) }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /UNSUPPORTED_LAVISH/);
  assert.deepEqual(calls, ['GET /health']);
});

