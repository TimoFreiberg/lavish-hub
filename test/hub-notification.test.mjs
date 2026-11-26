import test from 'node:test';
import assert from 'node:assert/strict';
import { formatNotificationBatch } from '../src/hub-runtime.mjs';
import { formatHubError } from '../src/hub-errors.mjs';
import { parseArgs } from '../src/cli.mjs';

test('notifications normalize diff, selection and sibling messages without snapshots', () => {
  const target = { type: 'diff-line', oldPath: 'old.js', newPath: 'new.js', side: 'additions', start: 2, end: 3, revision: 'abc' };
  const batch = { batch_id: 'one', dom_snapshot: '<body>', snapshot_page: 'doc.html', prompts: [
    { prompt: 'Hub view: Changes (changes)\nRevision range: base..head\n\nadditions file:2 (abc)\n\n```js\nline\n```\n\nFix this', target },
    { prompt: 'unrecognized prefix', target },
    { prompt: 'Change this', page: 'doc.html', uid: 'a', tag: 'p', selector: 'p', text: 'some text', target: { type: 'text-range', text: 'some' }, attachments: [{ name: 'a' }] },
    { prompt: 'General note', page: 'doc.html', tag: 'message', uid: 'bogus' },
    { prompt: 'Table', tag: 'td', target: { type: 'table-cell', row: 1 } },
  ] };
  const options = { identity: { root: '/workspace', session: 'review' }, instance: 'owner', page: '/hub.html', selected: 'changes', documents: [], siblingSources: new Map([['doc.html', { id: 'review', source: '/review.html' }]]) };
  const result = formatNotificationBatch(batch, options);
  assert.equal(result.batchId, 'one'); assert.equal(result.hasDomContext, true);
  assert.equal('context' in result, false); assert.equal('reply' in result, false);
  assert.deepEqual(result.prompts[0], { message: 'Fix this', artifact: { kind: 'diff', view: 'diff' }, diff: { file: 'new.js', oldPath: 'old.js', side: 'additions', startLine: 2, endLine: 3, revision: 'abc', range: 'base..head', quote: '```js\nline\n```' } });
  assert.equal(result.prompts[1].message, 'unrecognized prefix');
  assert.deepEqual(result.prompts[2].artifact, { kind: 'document', id: 'review', document: '/review.html' });
  assert.deepEqual(result.prompts[2].selection, { text: 'some' });
  assert.deepEqual(result.prompts[2].element, { uid: 'a', tag: 'p', selector: 'p', text: 'some text' });
  assert.equal(result.prompts[2].attachments.length, 1);
  assert.equal('element' in result.prompts[3], false);
  assert.equal(result.prompts[4].target.type, 'table-cell');
  const failure = formatNotificationBatch({ ...batch, prompts: [] }, options);
  assert.equal(failure.snapshotDocument, '/review.html');
});

test('batch reply parsing accepts dash-prefixed text and errors advertise actions', () => {
  for (const args of [['--text', '- bullet'], ['--agent-reply', '- bullet'], ['--', '- bullet'], ['- bullet']]) {
    assert.equal(parseArgs(['reply', '--batch', 'one', ...args]).text, '- bullet');
  }
  assert.equal(parseArgs(['context', '--batch', 'one']).batchId, 'one');
  assert.match(formatHubError(Object.assign(new Error('lost'), { ambiguousDelivery: true })), /\[AMBIGUOUS_DELIVERY\] action=check_delivery/);
  assert.match(formatHubError(Object.assign(new Error('ended'), { code: 'SESSION_ENDED' })), /\[SESSION_ENDED\] action=reconnect/);
});
