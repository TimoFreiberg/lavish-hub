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
    'static:html-document:1440x900:dark', 'static:markdown-document:1440x900:dark',
    'static:diff-jj:1440x900:dark', 'static:task-long-edit:1440x900:dark',
    'static:pr-configured-rendered:1440x900:dark', 'integration:diff-jj:1440x900:dark',
    'integration:task-changed-on-disk-edit:1440x900:dark', 'integration:pr-configured-edit:1440x900:dark',
    'integration:hub-empty:1440x900:dark', 'integration:hub-stack:1440x900:dark',
    'integration:hub-dirty:1440x900:dark', 'integration:hub-conflict:1440x900:dark',
    'integration:hub-disconnected:1440x900:dark', 'integration:hub-changes:1440x900:dark',
    'integration:hub-tasks:1440x900:dark', 'integration:hub-pr:1440x900:dark',
    'integration:hub-markdown:1440x900:dark', 'integration:hub-html:1440x900:dark',
  ].sort());
});
