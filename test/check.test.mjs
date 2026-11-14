import test from 'node:test';
import assert from 'node:assert/strict';
import { runChecks } from '../scripts/check.mjs';

for (const failing of [undefined, 'install', 'shots', 'test', 'e2e']) {
  test(`correctness pipeline preserves ordering and propagates ${failing || 'no'} failure`, async () => {
    const events = [], snapshots = new Map(); let active = 0, maximum = 0;
    const result = await runChecks({
      directory: '<artifacts>',
      publish: async (name, value) => { snapshots.set(name, structuredClone(value)); events.push(name); },
      execute: async name => {
        events.push(name);
        if (['test', 'e2e'].includes(name)) {
          assert.ok(snapshots.has('screenshots-ready.json'));
          active++; maximum = Math.max(maximum, active);
          await new Promise(resolve => setImmediate(resolve)); active--;
        }
        return name === failing ? 7 : 0;
      },
    });
    assert.equal(result.status, failing ? 'failed' : 'passed');
    assert.equal(events[1], 'install');
    if (failing === 'install') {
      assert.equal(events.includes('shots'), false); assert.equal(snapshots.has('screenshots-ready.json'), false);
    } else {
      assert.ok(events.indexOf('shots') < events.indexOf('test'));
      assert.equal(maximum, 2);
      assert.equal(snapshots.get('screenshots-ready.json').status, failing === 'shots' ? 'failed' : 'passed');
      assert.deepEqual(Object.keys(result.stages).sort(), ['e2e', 'install', 'shots', 'test']);
    }
    assert.equal(snapshots.get('status.json').status, result.status);
    assert.equal(result.screenshotReviewRequired, true);
  });
}

test('correctness pipeline records stage exceptions and completes other checks', async () => {
  const result = await runChecks({ directory: '<artifacts>', publish: async () => {}, execute: async name => { if (name === 'test') throw new Error('launch failed'); return 0; } });
  assert.equal(result.status, 'failed'); assert.equal(result.stages.test.error, 'launch failed'); assert.equal(result.stages.e2e.code, 0);
});
