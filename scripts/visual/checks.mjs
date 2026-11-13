import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const axeSource = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8');

// Runs in the document being checked, including open shadow roots.
export function inspectGeometry() {
  const elements = [], parent = el => el.parentElement || el.getRootNode().host;
  const walk = root => { for (const el of root.querySelectorAll('*')) { elements.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
  walk(document);
  const label = el => {
    if (!el) return '(none)';
    if (el.id) return `${el.localName}#${el.id}`;
    const siblings = [...(el.parentNode?.children || [])].filter(node => node.localName === el.localName);
    const segment = `${el.localName}:nth-of-type(${siblings.indexOf(el) + 1})`;
    const p = parent(el);
    return p ? `${label(p)}${el.parentElement ? ' > ' : ' >>> '}${segment}` : segment;
  };
  const shown = el => {
    for (let p = el; p; p = parent(p)) {
      const s = getComputedStyle(p);
      if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || Number(s.opacity) === 0) return false;
    }
    return true;
  };
  const clippedText = [], controls = [];
  const tolerance = 1;
  for (const el of elements) {
    if (!shown(el) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION'].includes(el.tagName)) continue;
    for (const text of el.childNodes) {
      if (text.nodeType !== Node.TEXT_NODE || !text.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(text);
      const rects = [...range.getClientRects()].filter(r => r.width && r.height);
      let clipping, scrollX = false, scrollY = false;
      for (let p = el; p && !clipping; p = parent(p)) {
        const s = getComputedStyle(p), r = p.getBoundingClientRect();
        if (s.textOverflow === 'ellipsis') break;
        const x = !scrollX && ['hidden', 'clip'].includes(s.overflowX), y = !scrollY && ['hidden', 'clip'].includes(s.overflowY);
        if (rects.some(t => (x && (t.left < r.left - tolerance || t.right > r.right + tolerance)) || (y && (t.top < r.top - tolerance || t.bottom > r.bottom + tolerance)))) clipping = label(p);
        scrollX ||= ['auto', 'scroll'].includes(s.overflowX) && p.scrollWidth > p.clientWidth + tolerance;
        scrollY ||= ['auto', 'scroll'].includes(s.overflowY) && p.scrollHeight > p.clientHeight + tolerance;
      }
      if (clipping) clippedText.push({ target: label(el), container: clipping, text: text.textContent.trim().slice(0, 100) });
    }
    if (!el.matches('button, input:not([type=hidden]), textarea, select, a[href], [role=button], [tabindex]:not([tabindex="-1"])')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) { controls.push({ target: label(el), problem: 'zero-size' }); continue; }
    let unreachable = false, scrollX = false, scrollY = false, centerClipped = false;
    for (let p = parent(el); p; p = parent(p)) {
      const s = getComputedStyle(p), a = p.getBoundingClientRect();
      if ((['auto', 'scroll'].includes(s.overflowX) && (r.left + r.width / 2 < a.left || r.left + r.width / 2 > a.right)) || (['auto', 'scroll'].includes(s.overflowY) && (r.top + r.height / 2 < a.top || r.top + r.height / 2 > a.bottom))) centerClipped = true;
      if ((!scrollX && ['hidden', 'clip'].includes(s.overflowX) && (r.left < a.left - tolerance || r.right > a.right + tolerance)) || (!scrollY && ['hidden', 'clip'].includes(s.overflowY) && (r.top < a.top - tolerance || r.bottom > a.bottom + tolerance))) unreachable = true;
      scrollX ||= ['auto', 'scroll'].includes(s.overflowX) && p.scrollWidth > p.clientWidth + tolerance;
      scrollY ||= ['auto', 'scroll'].includes(s.overflowY) && p.scrollHeight > p.clientHeight + tolerance;
    }
    if (!scrollX && r.right <= 0) unreachable = true;
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    // Ordinary below-fold content and controls in scrollable panes are reachable.
    // A fixed control outside the viewport cannot be reached by scrolling.
    if (getComputedStyle(el).position === 'fixed' && (x < 0 || x > innerWidth || y < 0 || y > innerHeight)) unreachable = true;
    if (unreachable) { controls.push({ target: label(el), problem: 'off-screen-or-clipped' }); continue; }
    if (centerClipped || x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) continue;
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) { const next = hit.shadowRoot.elementFromPoint(x, y); if (!next || next === hit) break; hit = next; }
    let inside = false;
    for (let p = hit; p; p = parent(p)) if (p === el) inside = true;
    if (!inside) controls.push({ target: label(el), problem: 'overlapped', covering: label(hit) });
  }
  const unique = values => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
  return {
    horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0) > innerWidth + tolerance,
    clippedText: unique(clippedText), controls: unique(controls),
    scrolls: elements.some(el => shown(el) && el.scrollHeight > el.clientHeight + tolerance && ['auto', 'scroll'].includes(getComputedStyle(el).overflowY)) || document.documentElement.scrollHeight > innerHeight + tolerance,
  };
}

export async function scanDocument(frame) {
  const geometry = await frame.evaluate(inspectGeometry);
  await frame.evaluate(axeSource);
  const violations = await frame.evaluate(async () => {
    // Sandboxed artifacts have an opaque origin. Axe's auxiliary CSSOM XHR
    // would fail CORS even though the browser loaded the stylesheet normally.
    // Computed styles are available, and each document is scanned separately.
    const result = await axe.run(document, { resultTypes: ['violations'], preload: false, iframes: false });
    return result.violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => ({
      id: v.id, impact: v.impact, description: v.description,
      nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })),
    }));
  });
  return { geometry, accessibility: violations };
}

export function failedChecks(checks) {
  return Object.entries(checks).filter(([, value]) => Array.isArray(value) ? value.length : value === true).map(([name]) => name);
}
