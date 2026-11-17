import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePR, serializePR } from '../src/pr-format.mjs';
import { encodeCreatePR, decodeAction } from '../src/action-message.mjs';
import { textHash } from '../src/save.mjs';

test('PR title and body round trip preserves blank lines and Unicode', () => {
  for (const text of ['# Title\n\nBody 雪\n\n', '# Title\n', '# Spaces  \nBody\n\n']) assert.equal(serializePR(parsePR(text)), text);
  assert.deepEqual(parsePR('# Only title'), { title: 'Only title', body: '' });
  for (const text of ['Title\nbody', '# \nbody', '\n# Title', '#\n']) assert.throws(() => parsePR(text), /first line/);
  assert.throws(() => serializePR({ title: 'bad\nline', body: '' }), /single line/);
  assert.equal(serializePR(parsePR('# Windows\r\nBody\r\n')), '# Windows\nBody\r\n');
});
test('versioned action carries one validated save object', () => {
  const baseHash = textHash('original'), text = '# Title\n\nBody 雪\n';
  const encoded = encodeCreatePR(baseHash, text);
  assert.deepEqual(decodeAction(encoded), { action: 'create-pr', save: { baseHash, text } });
  assert.equal(encoded.split('lavish-kit-save').length, 1);
  for (const input of ['create-pr', 'lavish-kit-action/v1\nnull', 'lavish-kit-action/v1\n{"action":"other"}', 'lavish-kit-action/v1\n{"action":"create-pr","save":"bad"}']) assert.throws(() => decodeAction(input));
});
