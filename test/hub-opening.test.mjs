import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
