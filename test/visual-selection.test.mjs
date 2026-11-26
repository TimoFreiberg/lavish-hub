import { test } from 'node:test';
import assert from 'node:assert/strict';
import { variants, variantId } from '../scripts/visual/fixtures.mjs';
import { isSelected } from '../scripts/visual/selection.mjs';

test('preview capture selection has exactly the requested wide dark cases', () => {
  const cases = [];
  for (const source of ['static', 'integration']) for (const variant of variants) {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 480, height: 900 }]) for (const theme of ['light', 'dark']) {
      if (isSelected(source, variant, viewport, theme)) cases.push(`${source}:${variantId(variant)}:${viewport.width}x${viewport.height}:${theme}`);
    }
  }
  assert.deepEqual(cases.sort(), [
    ...['stack', 'tasks', 'markdown', 'html', 'conflict'].map(name => `static:hub-${name}:1440x900:dark`),
    'integration:hub-empty:1440x900:dark', 'integration:hub-stack:1440x900:dark',
    'integration:hub-dirty:1440x900:dark', 'integration:hub-conflict:1440x900:dark',
    'integration:hub-disconnected:1440x900:dark',
    'integration:hub-tasks:1440x900:dark',
    'integration:hub-markdown:1440x900:dark', 'integration:hub-html:1440x900:dark',
  ].sort());
});
