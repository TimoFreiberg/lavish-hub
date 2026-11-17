import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
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

test('opening helpers prepare and present without starting a relay', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-open-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'lavish-axi'), log = path.join(dir, 'calls');
  await writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\nprintf "url: http://localhost:123/review\\n"\n');
  await chmod(executable, 0o700);
  const page = path.join(dir, 'page.html');
  await writeFile(page, '<title>Example</title>');
  const module = pathToFileURL(path.resolve('src/lavish.mjs')).href;
  const script = `import { prepareReview, presentReview } from ${JSON.stringify(module)}; const r = await prepareReview(process.argv[1]); await presentReview(process.argv[1], r.url);`;
  const env = { ...process.env, PATH: `${dir}:/usr/bin:/bin`, CALLS: log, XDG_STATE_HOME: path.join(dir, 'state') };
  delete env.HC_TERMINAL_ID;
  execFileSync(process.execPath, ['--input-type=module', '-e', script, page], { env });
  assert.equal(await readFile(log, 'utf8'), `${page} --no-open\n`);
  await assert.rejects(readFile(path.join(dir, 'state', 'lavish-kit', 'relay.json')));
});
