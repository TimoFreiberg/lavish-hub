import { variantId } from './fixtures.mjs';
import { isSelected } from './selection.mjs';

// Validate the completed report against the artifact actually served by the run.
export function validateReport(report, variants, manifest) {
  const errors = [];
  const entries = new Map(manifest.pages.map(page => [page.id, page]));
  const records = new Map();
  for (const shot of report.shots) {
    if (records.has(shot.id)) errors.push(`Duplicate report record: ${shot.id}`);
    records.set(shot.id, shot);
  }
  let expected = 0;
  for (const variant of variants) for (const viewport of report.matrix.viewports) for (const colorScheme of report.matrix.colorSchemes) for (const source of ['static', 'integration']) {
    expected++;
    const id = [source, variantId(variant), viewport.width === 1440 ? 'wide' : 'narrow', colorScheme].join('-');
    const shot = records.get(id);
    if (!shot) { errors.push(`Missing report record: ${id}`); continue; }
    const selected = isSelected(source, variant, viewport, colorScheme);
    if (shot.source !== source || shot.selected !== selected || shot.viewport.width !== viewport.width || shot.viewport.height !== viewport.height || shot.colorScheme !== colorScheme) errors.push(`Incorrect report metadata: ${id}`);
    if (source === 'static' && (!entries.has(variantId(variant)) || shot.url !== entries.get(variantId(variant)).url)) errors.push(`Incorrect preview URL: ${id}`);
    if (!shot.failures.length && (Boolean(shot.png) !== selected)) errors.push(`Incorrect capture selection: ${id}`);
    if (!shot.failures.length && (!shot.checks.accessibility || !shot.checks.pageErrors || !shot.checks.consoleErrors || (source === 'integration' && !shot.checks.lavishLayout))) errors.push(`Incomplete checks: ${id}`);
  }
  if (report.shots.length !== expected) errors.push(`Expected ${expected} report records, got ${report.shots.length}`);
  return errors;
}
