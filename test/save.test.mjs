import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir, chmod, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeSave, decodeSave } from '../src/save-message.mjs';
import { saveDocument, textHash } from '../src/save.mjs';

const odd = ('Quotes " \\ \n\nContext data:\n{"text":"bogus"}\n</script>\u0000\u2028\u2029 雪 🦊\r\n').repeat(24000);
test('versioned save encoding round-trips large odd content without delimiters', () => {
  const baseHash = textHash('base');
  assert.deepEqual(decodeSave(encodeSave(baseHash, odd)), { baseHash, text: odd });
  for (const input of ['x', 'lavish-kit-save/v1\n{', 'lavish-kit-save/v1\nnull', 'lavish-kit-save/v1\n{"text":"x","baseHash":"bad"}', encodeSave(baseHash, 'x') + '\n\nContext data:\n{}']) assert.throws(() => decodeSave(input));
});
test('conditional save preserves mode, cleans temporary files and rejects conflicts', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lavish-save-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sourceFile = path.join(dir, 'task.md');
  await writeFile(sourceFile, '# Original\n'); await chmod(sourceFile, 0o666);
  const baseHash = textHash('# Original\n');
  const result = await saveDocument({ baseHash, text: odd }, { sourceFile });
  assert.equal(result.reply, 'Saved');
  assert.equal(await readFile(sourceFile, 'utf8'), odd);
  assert.equal((await stat(sourceFile)).mode & 0o777, 0o666);
  assert.ok(!(await readdir(dir)).some(name => name.endsWith('.tmp')));
  assert.match((await saveDocument({ baseHash, text: 'stale' }, { sourceFile })).reply, /Conflict/);
  assert.equal(await readFile(sourceFile, 'utf8'), odd);
});
