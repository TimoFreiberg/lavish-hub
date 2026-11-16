import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHubCommands } from '../src/hub-commands.mjs';

test('a command cannot leave a background child after its leader exits', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-child-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'marker');
  const commands = await createHubCommands(dir, dir);
  const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify("setTimeout(() => require('fs').writeFileSync(process.argv[1], 'escaped'), 500)")}, process.argv[1]],{stdio:'ignore'}).unref()`;
  const result = await commands.execute({ id: 'background', argv: [process.execPath, '-e', script, marker] });
  assert.equal(result.code, 0);
  await new Promise(resolve => setTimeout(resolve, 1000));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  commands.close();
});
