import assert from 'node:assert/strict';
import test from 'node:test';
import { diffDigest, matchesDiffAnchor } from '../web/diff-anchors.mjs';

test('diff identity changes with the source, revision, range, and patch', async () => {
  const data = { root: '/repo', range: 'base → working', revision: null, patch: 'first' };
  const digest = await diffDigest(data);
  assert.match(digest, /^[a-f0-9]{64}$/);
  for (const changed of [{root:'/other'}, {range:'other'}, {revision:'abc'}, {patch:'second'}]) {
    assert.notEqual(await diffDigest({ ...data, ...changed }), digest);
  }
  assert.equal(await diffDigest({ ...data }), digest);
});

test('the digest remains identical without Web Crypto', async () => {
  const data = { root: '/repo', range: 'stdin', patch: 'λ\n' };
  const expected = await diffDigest(data);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    assert.equal(await diffDigest(data), expected);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else delete globalThis.crypto;
  }
});

test('matching an anchor requires the full diff identity, both paths, side and line range', () => {
  const anchor = { digest: 'abc', oldPath: 'old', newPath: 'new', side: 'deletions', start: 4, end: 5 };
  const file = { oldPath: 'old', newPath: 'new' };
  assert.equal(matchesDiffAnchor(anchor, 'abc', file), true);
  assert.equal(matchesDiffAnchor(anchor, 'different', file), false);
  assert.equal(matchesDiffAnchor(anchor, 'abc', { ...file, oldPath: 'changed' }), false);
  assert.equal(matchesDiffAnchor({ ...anchor, side: 'other' }, 'abc', file), false);
  assert.equal(matchesDiffAnchor({ ...anchor, start: 6 }, 'abc', file), false);
});
