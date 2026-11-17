import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReport } from '../scripts/visual/report-validation.mjs';

test('report validation rejects missing records and incorrect capture provenance', () => {
  const variant = { kind: 'hub', name: 'stack' };
  const viewport = { width: 1440, height: 900 };
  const manifest = { pages: [{ id: 'hub-stack', url: 'hub-stack/page/index.html' }] };
  const checks = { accessibility: [], pageErrors: [], consoleErrors: [] };
  const report = { matrix: { viewports: [viewport], colorSchemes: ['dark'] }, shots: [
    { id: 'static-hub-stack-wide-dark', source: 'static', viewport, colorScheme: 'dark', selected: true, png: 'static.png', url: manifest.pages[0].url, checks, failures: [] },
    { id: 'integration-hub-stack-wide-dark', source: 'integration', viewport, colorScheme: 'dark', selected: true, png: 'integration.png', checks: { ...checks, lavishLayout: [] }, failures: [] },
  ] };
  assert.deepEqual(validateReport(report, [variant], manifest), []);
  report.shots[0].url = 'other/page/index.html';
  assert.match(validateReport(report, [variant], manifest).join(), /Incorrect preview URL/);
  report.shots[0].url = manifest.pages[0].url;
  delete report.shots[0].png;
  assert.match(validateReport(report, [variant], manifest).join(), /Incorrect capture selection/);
  report.shots.pop();
  assert.match(validateReport(report, [variant], manifest).join(), /Missing report record/);
});
