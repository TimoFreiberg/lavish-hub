import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFilePath, parseLineSpec, resolveFileEntry, resolveTargetSide, isRangeInHunks, fileLineCount } from '../web/diff-target.mjs';

test('resolves paths and validates line targets', () => {
  const files = [{ newPath: 'new.txt', oldPath: 'old.txt', status: 'renamed' }, { newPath: 'old.txt', oldPath: 'gone.txt', status: 'deleted' }];
  assert.equal(normalizeFilePath(' ./src/a '), 'src/a');
  assert.equal(resolveFileEntry(files, '/old.txt').index, 1);
  assert.equal(resolveFileEntry(files, './gone.txt').index, 1);
  assert.equal(resolveFileEntry(files, 'missing'), null);
  assert.deepEqual(parseLineSpec('10-20'), { start: 10, end: 20 });
  assert.deepEqual(parseLineSpec('42'), { start: 42, end: 42 });
  for (const value of ['0', '2-1', '-1', '1-0', '1x', '123456789']) assert.equal(parseLineSpec(value), null);
  assert.equal(resolveTargetSide(files[0]), 'additions');
  assert.equal(resolveTargetSide(files[1]), 'deletions');
  assert.equal(resolveTargetSide(files[1], 'new'), 'additions');
  assert.equal(resolveTargetSide(files[0], 'old'), 'deletions');
});

test('checks hunk coverage and full-file line counts', () => {
  const parsed = { hunks: [{ additionStart: 1, additionCount: 3, deletionStart: 2, deletionCount: 2 }, { additionStart: 7, additionCount: 2, deletionStart: 9, deletionCount: 1 }] };
  assert.equal(isRangeInHunks(parsed, 1, 3, 'additions'), true);
  assert.equal(isRangeInHunks(parsed, 3, 7, 'additions'), false);
  assert.equal(isRangeInHunks(parsed, 2, 3, 'deletions'), true);
  assert.equal(fileLineCount({ newFile: { contents: 'a\nb\n' } }, 'additions'), 2);
  assert.equal(fileLineCount({ oldFile: { contents: 'a\nb' } }, 'deletions'), 2);
  assert.equal(fileLineCount({ newFile: { contents: '' } }, 'additions'), 0);
});
