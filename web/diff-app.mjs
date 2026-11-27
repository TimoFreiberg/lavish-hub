import { CodeView, getFiletypeFromFileName, registerCustomTheme } from '@pierre/diffs';
import { syntaxTheme, palette } from '../src/orangebox.mjs';
registerCustomTheme('orangebox', async () => syntaxTheme);
import { WorkerPoolManager } from '@pierre/diffs/worker';
import { modelPatch } from '../src/diff/model.mjs';
import { commentLocation, quoteSelection, zedCommand, zedUrl } from './locations.mjs';
import { diffDigest, matchesDiffAnchor } from './diff-anchors.mjs';
import { parseLineSpec, resolveFileEntry, resolveTargetSide, isRangeInHunks, fileLineCount } from './diff-target.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgIcon(paths, size = 14, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  for (const spec of paths) {
    const node = document.createElementNS(SVG_NS, spec.tag || 'path');
    for (const [k, v] of Object.entries(spec)) if (k !== 'tag') node.setAttribute(k, String(v));
    svg.append(node);
  }
  return svg;
}
const chevronIcon = (cls = 'chevron') => svgIcon([{ d: 'M6 4l4 4-4 4' }], 14, cls);
const copyIcon = () => svgIcon([{ tag: 'rect', x: 5.5, y: 5.5, width: 7.5, height: 7.5, rx: 1.5 }, { d: 'M3.5 10.5H3A1.5 1.5 0 0 1 1.5 9V3A1.5 1.5 0 0 1 3 1.5h6A1.5 1.5 0 0 1 10.5 3v.5' }], 13);
const unifiedIcon = () => svgIcon([{ tag: 'rect', x: 2, y: 2.5, width: 12, height: 11, rx: 1.5 }, { d: 'M4.5 6h7M4.5 9.5h5' }], 14);
const splitIcon = () => svgIcon([{ tag: 'rect', x: 2, y: 2.5, width: 12, height: 11, rx: 1.5 }, { d: 'M8 2.5v11' }], 14);
const wrapIcon = () => svgIcon([{ d: 'M2.5 4.5h11M2.5 8h8a2 2 0 0 1 0 4H8.5M10 10.5L8.5 12l1.5 1.5M2.5 11.5h3.5' }], 14);
const foldIcon = collapsed => svgIcon(collapsed ? [{ d: 'M5 6l3-3 3 3M5 10l3 3 3-3' }] : [{ d: 'M5 4l3 3 3-3M5 12l3-3 3 3' }], 14);
const searchIcon = () => svgIcon([{ tag: 'circle', cx: 7, cy: 7, r: 4.5 }, { d: 'M10.5 10.5L14 14' }], 13, 'search-icon');
const folderIcon = () => svgIcon([{ d: 'M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5H12.5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7z' }], 14, 'folder-icon');
function statusIcon(status) {
  const frame = { tag: 'rect', x: 2, y: 2, width: 12, height: 12, rx: 3 };
  if (status === 'added') return svgIcon([frame, { d: 'M8 5.2v5.6M5.2 8h5.6' }], 15, 'status-icon status-added');
  if (status === 'deleted') return svgIcon([frame, { d: 'M5.2 8h5.6' }], 15, 'status-icon status-deleted');
  if (status === 'renamed' || status === 'copied') return svgIcon([frame, { d: 'M5 8h6M8.5 5.5L11 8l-2.5 2.5' }], 15, 'status-icon status-renamed');
  return svgIcon([frame, { tag: 'circle', cx: 8, cy: 8, r: 1.8, fill: 'currentColor', stroke: 'none' }], 15, 'status-icon status-modified');
}

function buildFileTree(files, filterText) {
  const query = filterText.trim().toLowerCase();
  const root = { name: '', path: '', dirs: new Map(), files: [] };
  files.forEach((file, index) => {
    if (query && !file.newPath.toLowerCase().includes(query)) return;
    const parts = file.newPath.split('/');
    let node = root, prefix = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      prefix = prefix ? `${prefix}/${part}` : part;
      let next = node.dirs.get(part);
      if (!next) { next = { name: part, path: prefix, dirs: new Map(), files: [] }; node.dirs.set(part, next); }
      node = next;
    }
    node.files.push({ file, index, name: parts[parts.length - 1] });
  });
  function compact(node) {
    const compactedDirs = new Map();
    for (const [, child] of node.dirs) {
      let current = child;
      let label = current.name;
      while (current.dirs.size === 1 && current.files.length === 0) {
        const [, only] = [...current.dirs.entries()][0];
        label = `${label}/${only.name}`;
        current = only;
      }
      const merged = compact({ name: label, path: current.path, dirs: current.dirs, files: current.files });
      compactedDirs.set(merged.path, merged);
    }
    return { ...node, dirs: compactedDirs };
  }
  return compact(root);
}

export function mountDiff(app, { embedded = false, hideSidebar = false, collapsedByDefault = false, loadDiffFiles } = {}) {
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
const button = (text, action, cls) => { const node = el('button', text, cls); node.type = 'button'; node.addEventListener('click', action); return node; };
const state = {
  data: null, files: [], counts: [], totals: { add: 0, del: 0 },
  hash: null, latest: null, pending: null,
  split: false, wrap: false, filter: '', collapsedDirs: new Set(),
  viewed: new Set(), collapsed: new Set(), expanded: new Set(), current: 0, hunk: -1, draft: null, storageFailed: false,
};
if (!embedded) window.addEventListener('beforeunload', event => { if (state.draft?.textarea.value) { event.preventDefault(); event.returnValue = ''; } });
if (!window.lavishPreview) try { state.viewed = new Set(JSON.parse(localStorage.getItem('lavish-hub-viewed') || '[]')); } catch { state.storageFailed = true; }
const header = el('header', null, 'page-header'), toolbar = el('div', null, 'toolbar'), sidebar = el('nav', null, 'sidebar'), viewport = el('div', null, 'viewport'), notice = el('div', null, 'notice'), expansionNotice = el('div', null, 'notice'), targetNotice = el('div', null, 'notice');
sidebar.setAttribute('aria-label', 'Changed files');
expansionNotice.setAttribute('role', 'status');
targetNotice.setAttribute('role', 'status');
let revealGeneration = 0, highlightTimer = 0;
// Expansion failures belong to the file that produced them: each displayed
// snapshot indexes its own files, so a new snapshot starts with no failures.
let expansionFailures = new Set();
function updateExpansionNotice() { expansionNotice.textContent = expansionFailures.size ? 'Unchanged lines are unavailable for this file or snapshot. The original diff is still shown.' : ''; }
// Lavish sees the shadow host, not the clicked diff line. Let CodeView handle
// this surface even when Lavish's annotation mode is active.
viewport.setAttribute('data-lavish-action', '');
const layout = el('div', null, 'layout'); if (!hideSidebar) layout.append(sidebar); layout.append(viewport); app.append(header, notice, expansionNotice, targetNotice, layout);
const gutterObservers = new WeakMap();
let view, worker, workerUrl, fallingBack = false;
let diffAnchors = [], slots = [], generation = null, placementFrame = 0, reportedPlacements = false;
const slotHeights = new Map();
function reportPlacements(placements) {
  reportedPlacements = placements.length > 0;
  if (generation !== null) window.lavish?.reportDiffPlacements?.(generation, placements);
}
function schedulePlacements() {
  if (!slots.length) {
    if (reportedPlacements) reportPlacements([]);
    return;
  }
  if (placementFrame) cancelAnimationFrame(placementFrame);
  placementFrame = requestAnimationFrame(() => {
    placementFrame = 0;
    if (!app.isConnected) return;
    const bounds = viewport.getBoundingClientRect();
    let clipTop = bounds.top;
    for (const fileHead of viewport.querySelectorAll('.file-header')) {
      const rect = fileHead.getBoundingClientRect();
      if (rect.top <= bounds.top + 1 && rect.bottom > bounds.top && rect.right > bounds.left && rect.left < bounds.right) clipTop = Math.max(clipTop, rect.bottom);
    }
    const placements = [];
    for (const slot of slots) {
      if (!slot.box.isConnected) continue;
      const rect = slot.box.getBoundingClientRect();
      const left = Math.max(rect.left, bounds.left, 0), top = Math.max(rect.top, clipTop, 0);
      const right = Math.min(rect.right, bounds.right, window.innerWidth), bottom = Math.min(rect.bottom, bounds.bottom, window.innerHeight);
      if (right > left && bottom > top) placements.push({ id: slot.id, x: rect.left, y: rect.top, width: rect.width, height: rect.height, clip: { x: bounds.left, y: clipTop, width: bounds.width, height: bounds.bottom - clipTop } });
    }
    reportPlacements(placements);
  });
}
function updateSlots() {
  slots = [];
  if (state.digest) for (const anchor of diffAnchors) {
    const index = anchor.fileIndex;
    if (!Number.isSafeInteger(index) || index < 0 || !state.files[index] || !matchesDiffAnchor(anchor, state.digest, state.files[index])) continue;
    const box = el('div', null, 'queued-diff-slot');
    box.style.height = `${slotHeights.get(anchor.id) || 38}px`;
    slots.push({ id: anchor.id, index, box, annotation: { side: anchor.side, lineNumber: anchor.end, metadata: { box } } });
  }
  setItems();
  schedulePlacements();
}
window.addEventListener('lavish:queuedDiffSizes', event => {
  if (event.detail?.generation !== generation || !Array.isArray(event.detail?.sizes) || event.detail.sizes.length > 1000) return;
  const changed = new Set(), slotsById = new Map(slots.map(slot => [slot.id, slot]));
  for (const item of event.detail.sizes) {
    const slot = slotsById.get(item?.id);
    if (!slot || !Number.isInteger(item.height) || item.height < 38 || item.height > 320 || slotHeights.get(item.id) === item.height) continue;
    slotHeights.set(item.id, item.height);
    slot.box.style.height = `${item.height}px`;
    changed.add(slot.index);
  }
  if (changed.size) {
    state.version++;
    for (const index of changed) view.updateItem(itemFor(state.files[index], index));
    schedulePlacements();
  }
});
window.addEventListener('lavish:scrollDiff', event => {
  if (!app.isConnected) return;
  const { x, y } = event.detail || {};
  if (Number.isFinite(x) && Number.isFinite(y)) viewport.scrollBy({ left: x, top: y, behavior: 'instant' });
});
window.addEventListener('lavish:queuedDiffAnchors', event => {
  generation = event.detail?.generation;
  diffAnchors = Array.isArray(event.detail?.anchors) ? event.detail.anchors : [];
  const activeIds = new Set(diffAnchors.map(anchor => anchor?.id));
  for (const id of slotHeights.keys()) if (!activeIds.has(id)) slotHeights.delete(id);
  updateSlots();
});
function requestDiffAnchors() { window.lavish?.requestDiffAnchors?.(); }
window.addEventListener('lavish:ready', requestDiffAnchors);
requestDiffAnchors();
window.addEventListener('resize', schedulePlacements);
window.addEventListener('scroll', schedulePlacements, true);
new ResizeObserver(schedulePlacements).observe(viewport);
// CodeView lays items out from itemMetrics without measuring headers, so the
// header must render at exactly this height or every later file drifts.
const HEADER_HEIGHT = 44;
const LINE_HEIGHT = 21;
function persist() { if (window.lavishPreview) return; try { localStorage.setItem('lavish-hub-viewed', JSON.stringify([...state.viewed])); } catch { state.storageFailed = true; renderToolbar(); } }
function makeWorker() {
  workerUrl = URL.createObjectURL(new Blob([LAVISH_HUB_WORKER_SOURCE], { type: 'text/javascript' }));
  const poolSize = Math.min(4, Math.max(2, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
  return new WorkerPoolManager({ poolSize, workerFactory: () => new Worker(workerUrl), onWorkerError: event => { event.preventDefault?.(); fallback(); } }, { theme: 'orangebox', themeType: 'dark', langs: [] });
}
function fallback() {
  if (fallingBack) return; fallingBack = true;
  try { worker?.terminate(); } catch {} worker = undefined;
  if (workerUrl) URL.revokeObjectURL(workerUrl);
  if (view) { const top = view.getScrollTop(); view.cleanUp(); createView(); setItems(); view.scrollTo({ type: 'position', position: top }); }
}
try { worker = makeWorker(); worker.initialize().catch(fallback); } catch { fallback(); }
function options() { return {
  theme: 'orangebox', themeType: 'dark', preferredHighlighter: 'shiki-js',
  diffStyle: state.split ? 'split' : 'unified',
  diffIndicators: 'bars',
  hunkSeparators: 'line-info',
  overflow: state.wrap ? 'wrap' : 'scroll',
  lineHoverHighlight: 'both',
  enableLineSelection: true,
  loadDiffFiles: async parsed => {
    const data = state.data, index = state.files.findIndex(item => item.parsed === parsed || (parsed?.cacheKey != null && item.parsed?.cacheKey === parsed.cacheKey)), file = state.files[index];
    // A result that settles after the display moved on describes a file nobody is
    // looking at any more, so it must neither be shown nor clear a current notice.
    const current = () => state.data === data && index >= 0 && state.files[index] === file;
    try {
      if (!loadDiffFiles || !data?.operationId || !file) throw new Error('unavailable');
      const files = await loadDiffFiles(data.operationId, index, data.snapshotVersion, data.rangeKey);
      // Clear only this file's failure: another file expanding successfully says
      // nothing about a file whose read is still unavailable.
      if (current()) { file.fullFiles = files; expansionFailures.delete(index); updateExpansionNotice(); }
      return files;
    } catch (error) {
      if (current()) { expansionFailures.add(index); updateExpansionNotice(); }
      throw error;
    }
  },
  unsafeCSS: `:host {
    --diffs-font-size: 13px;
    --diffs-line-height: ${LINE_HEIGHT}px;
    --diffs-font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Monaco, Consolas, monospace;
    --diffs-addition-color-override: ${palette['diff-add']};
    --diffs-deletion-color-override: ${palette['diff-del']};
    --diffs-modified-color-override: ${palette.orange};
    --diffs-bg-addition-override: color-mix(in srgb, ${palette['diff-add']} 13%, ${palette.bg});
    --diffs-bg-deletion-override: color-mix(in srgb, ${palette['diff-del']} 13%, ${palette.bg});
    --diffs-bg-addition-emphasis-override: color-mix(in srgb, ${palette['diff-add']} 28%, ${palette.bg});
    --diffs-bg-deletion-emphasis-override: color-mix(in srgb, ${palette['diff-del']} 28%, ${palette.bg});
    --diffs-bg-addition-number-override: color-mix(in srgb, ${palette['diff-add']} 18%, ${palette.bg});
    --diffs-bg-deletion-number-override: color-mix(in srgb, ${palette['diff-del']} 18%, ${palette.bg});
    --diffs-bg-separator-override: color-mix(in srgb, ${palette.raised} 72%, ${palette.bg});
    --diffs-bg-buffer-override: color-mix(in srgb, ${palette.surface} 85%, ${palette.bg});
    --diffs-bg-hover-override: color-mix(in srgb, ${palette.raised} 55%, ${palette.bg});
    --diffs-fg-number-override: color-mix(in srgb, ${palette.muted} 72%, ${palette.bg});
    --diffs-gap-style: 6px;
  }
  [data-diffs] { border-radius: 7px; }`,
  itemMetrics: { diffHeaderHeight: HEADER_HEIGHT, lineHeight: LINE_HEIGHT },
  layout: { paddingTop: 10, paddingBottom: 16, gap: 10 },
  stickyHeaders: true,
  renderCustomHeader: (_metadata, context) => fileHeader(Number(context.item.id)),
  enableGutterUtility: true,
  onPostRender: (node, instance, phase, context) => {
    gutterObservers.get(node)?.disconnect();
    schedulePlacements();
    if (phase === 'unmount') { gutterObservers.delete(node); return; }
    const label = () => {
      const add = node.shadowRoot?.querySelector('[data-utility-button]');
      if (!add || add.hasAttribute('aria-label')) return;
      add.setAttribute('aria-label', 'Add comment'); add.title = 'Add comment (drag to select a range)';
      add.addEventListener('click', event => {
        // The library handles pointer clicks and drags, but not keyboard clicks.
        if (event.detail !== 0) return;
        const selection = view.getSelectedLines(), line = instance.getHoveredLine();
        if (selection?.id === context.item.id) openDraft(Number(context.item.id), selection.range);
        else if (line) openDraft(Number(context.item.id), { start: line.lineNumber, end: line.lineNumber, side: line.side });
      });
    };
    label();
    // The built-in button is inserted only once a line is hovered or selected.
    const observer = new MutationObserver(label); observer.observe(node.shadowRoot, { childList: true, subtree: true }); gutterObservers.set(node, observer);
  },
  onGutterUtilityClick: (range, context) => openDraft(Number(context.item.id), range),
  renderAnnotation: annotation => annotation.metadata.box,
}; }
function currentAt(top) { let low = 0, high = state.files.length; while (low < high) { const mid = (low + high) >>> 1, itemTop = view.getTopForItem(String(mid)); if (itemTop != null && itemTop <= top + 1) low = mid + 1; else high = mid; } return Math.max(0, low - 1); }
function createView() { view = new CodeView(options(), worker); view.setup(viewport); view.subscribeToScroll(top => { schedulePlacements(); const current = currentAt(top); if (current !== state.current) { state.current = current; state.hunk = -1; markCurrent(); } }); }
createView();
// Scroll only the sidebar tree; scrollIntoView would also scroll Lavish's parent page.
function markCurrent() {
  if (hideSidebar) return;
  const tree = sidebar.querySelector('.file-tree');
  sidebar.querySelectorAll('.file-link').forEach(link => {
    const idx = Number(link.dataset.index);
    if (idx !== state.current) { link.removeAttribute('aria-current'); return; }
    link.setAttribute('aria-current', 'true');
    if (!tree) return;
    const top = link.offsetTop - 32, bottom = link.offsetTop + link.offsetHeight + 8;
    if (top < tree.scrollTop) tree.scrollTop = top; else if (bottom > tree.scrollTop + tree.clientHeight) tree.scrollTop = bottom - tree.clientHeight;
  });
}
function count(file) { let add = 0, del = 0, inHunk = false; for (const line of file.raw.split('\n')) { if (line.startsWith('@@ ')) inHunk = true; else if (inHunk && line.startsWith('+')) add++; else if (inHunk && line.startsWith('-')) del++; } return { add, del }; }
function summary(file) {
  if (file.parseError) return `Could not parse: ${file.parseError}`;
  if (file.status === 'binary') return 'Binary';
  if (file.status === 'mode-only') return `mode ${file.oldMode} → ${file.newMode}`;
  if (file.status === 'renamed' && !file.parsed?.hunks?.length) return `Renamed from ${file.oldPath}`;
  const parts = [];
  if (file.status === 'type-change') parts.push(`Type ${file.oldMode} → ${file.newMode}`);
  if (file.oldMode === '120000' || file.newMode === '120000') parts.push('Symlink');
  if (file.status === 'added') parts.push('New');
  if (file.status === 'deleted') parts.push('Deleted');
  if (file.status === 'renamed') parts.push(`from ${file.oldPath}`);
  return parts.join(' · ');
}
function toggleViewed(index) {
  const file = state.files[index]; if (!file?.viewedKey) return;
  state.viewed.has(file.viewedKey) ? state.viewed.delete(file.viewedKey) : state.viewed.add(file.viewedKey);
  persist(); renderSidebar(); updateEmbeddedSummary();
  state.version++;
  if (view) view.updateItem(itemFor(file, index));
}
function isCollapsed(path) { return collapsedByDefault ? !state.expanded.has(path) : state.collapsed.has(path); }
function toggleCollapsed(file, index) {
  const paths = collapsedByDefault ? state.expanded : state.collapsed;
  paths.has(file.newPath) ? paths.delete(file.newPath) : paths.add(file.newPath);
  state.version++;
  if (view) view.updateItem(itemFor(file, index));
  renderToolbar();
}
function toggleCollapseAll() {
  const allCollapsed = state.files.length > 0 && state.files.every(file => isCollapsed(file.newPath));
  if (collapsedByDefault) {
    if (allCollapsed) for (const file of state.files) state.expanded.add(file.newPath);
    else state.expanded.clear();
  } else if (allCollapsed) state.collapsed.clear();
  else for (const file of state.files) state.collapsed.add(file.newPath);
  setItems();
  renderToolbar();
}
async function copyText(text) { try { await navigator.clipboard.writeText(text); } catch { window.prompt('Copy command', text); } }
function showRaw(file) { const dialog = el('dialog', null, 'raw-dialog'); dialog.append(el('strong', file.newPath), el('pre', file.raw, 'raw'), button('Close', () => dialog.close())); dialog.addEventListener('close', () => dialog.remove()); app.append(dialog); dialog.showModal(); }
function fileHeader(index) {
  const file = state.files[index]; if (!file) return el('div');
  const collapsed = isCollapsed(file.newPath);
  const box = el('div', null, `file-header${collapsed ? ' is-collapsed' : ''}`);
  box.addEventListener('click', event => { if (!event.target.closest('button, a, input, label') && !window.getSelection()?.toString()) toggleCollapsed(file, index); });
  box.dataset.file = file.newPath;
  box.style.height = `${HEADER_HEIGHT}px`;

  const toggle = button('', () => toggleCollapsed(file, index), `icon collapse-btn${collapsed ? '' : ' is-open'}`);
  toggle.append(chevronIcon());
  toggle.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${file.newPath}`);
  toggle.setAttribute('aria-expanded', String(!collapsed));

  const title = el('strong', null, 'path');
  title.title = file.newPath;
  const slash = file.newPath.lastIndexOf('/');
  if (slash >= 0) {
    title.append(el('span', `${file.newPath.slice(0, slash + 1)}`, 'path-dir'), el('span', file.newPath.slice(slash + 1), 'path-base'));
  } else {
    title.textContent = file.newPath;
  }

  const main = el('div', null, 'file-main');
  main.append(toggle, statusIcon(file.status), title);

  const description = summary(file);
  if (description) {
    const badge = el('span', description, `file-badge status-${file.status}`);
    badge.title = description;
    main.append(badge);
  }
  if (file.parseError) main.append(button('Show raw patch', () => showRaw(file), 'raw-btn'));

  const meta = el('div', null, 'file-meta');
  const c = state.counts[index] || count(file);
  const counts = el('span', null, 'counts');
  if (c.del > 0 || c.add === 0) counts.append(el('span', `−${c.del}`, 'del'));
  if (c.add > 0 || c.del === 0) {
    if (counts.childNodes.length) counts.append(' ');
    counts.append(el('span', `+${c.add}`, 'add'));
  }
  meta.append(counts);

  const hunks = file.parsed?.hunks || [];
  if (hunks.length) {
    const side = file.status === 'deleted' ? 'deletions' : 'additions', path = side === 'deletions' ? file.oldPath : file.newPath;
    const links = el('span', null, 'zed-links');
    hunks.forEach((hunk, hunkIdx) => {
      const lineNumber = Math.max(1, side === 'deletions' ? hunk.deletionStart : hunk.additionStart);
      const link = el('a', hunkIdx === 0 ? 'Open in Zed' : `:${lineNumber}`, 'zed-open');
      link.href = window.lavishPreview ? '#' : zedUrl(state.data.root, path, lineNumber);
      if (window.lavishPreview) link.onclick = event => { event.preventDefault(); notice.textContent = 'Opening an editor is unavailable in the demo.'; };
      link.target = '_blank'; link.rel = 'noopener';
      link.setAttribute('aria-label', `Open in Zed :${lineNumber}`);
      link.title = `Open in Zed (${path}:${lineNumber})`;
      const copy = button('', () => copyText(zedCommand(state.data.root, path, lineNumber)), 'icon small');
      copy.append(copyIcon());
      copy.title = `Copy Zed command :${lineNumber}`;
      copy.setAttribute('aria-label', copy.title);
      const group = el('span', null, 'zed-link');
      group.append(link, copy);
      links.append(group);
    });
    meta.append(links);
  }

  const isViewed = state.viewed.has(file.viewedKey);
  const label = el('label', null, `viewed${isViewed ? ' is-checked' : ''}`);
  const check = el('input'); check.type = 'checkbox'; check.checked = isViewed;
  check.addEventListener('change', () => toggleViewed(index));
  label.append(check, ' Viewed');
  meta.append(label);

  box.append(main, meta);
  return box;
}
const supportedLanguages = new Set(LAVISH_HUB_LANGUAGES);
function itemFor(file, index) {
  if (file.parsed && !file.parseError) {
    const lang = getFiletypeFromFileName(file.parsed.name);
    file.parsed.lang = supportedLanguages.has(lang) ? lang : 'text';
    return { id: String(index), type: 'diff', fileDiff: file.parsed, version: state.version, collapsed: isCollapsed(file.newPath), annotations: [...slots.filter(slot => slot.index === index).map(slot => slot.annotation), ...(state.draft?.index === index ? [state.draft.annotation] : [])] };
  }
  return { id: String(index), type: 'file', file: { name: file.newPath, contents: '' }, collapsed: true };
}
function setItems() { state.version = (state.version || 0) + 1; if (view) view.setItems(state.files.map(itemFor)); }
function renderSidebar() {
  if (hideSidebar) return;
  const focused = sidebar.contains(document.activeElement) && document.activeElement.matches('.file-link, .dir-row')
    ? { selector: document.activeElement.classList.contains('dir-row') ? '.dir-row' : '.file-link', path: document.activeElement.dataset.path } : null;
  const prevTreeScroll = sidebar.querySelector('.file-tree')?.scrollTop || 0;
  const viewed = state.files.filter(file => state.viewed.has(file.viewedKey)).length;
  let head = sidebar.querySelector('.sidebar-head');
  if (!head) {
    head = el('div', null, 'sidebar-head');
    const titleRow = el('div', null, 'sidebar-title');
    titleRow.append(el('h2'));
    head.append(titleRow);

    const filterWrap = el('div', null, 'filter-wrap');
    const filterInput = el('input', null, 'file-filter');
    filterInput.type = 'search';
    filterInput.placeholder = 'Filter files…';
    filterInput.value = state.filter;
    filterInput.setAttribute('aria-label', 'Filter files');
    filterInput.addEventListener('input', () => { state.filter = filterInput.value; renderSidebar(); });
    filterWrap.append(searchIcon(), filterInput);
    head.append(filterWrap);
    sidebar.append(head);
  }
  head.querySelector('h2').textContent = `Files (${state.files.length})`;

  const treeEl = el('div', null, 'file-tree');
  treeEl.setAttribute('role', 'region');
  treeEl.setAttribute('aria-label', 'File tree');
  const tree = buildFileTree(state.files, state.filter);
  const filtering = state.filter.trim().length > 0;
  let renderedCount = 0;

  function appendTree(node, depth) {
    for (const [, dir] of node.dirs) {
      const collapsed = !filtering && state.collapsedDirs.has(dir.path);
      const dirBtn = button('', () => {
        state.collapsedDirs.has(dir.path) ? state.collapsedDirs.delete(dir.path) : state.collapsedDirs.add(dir.path);
        renderSidebar();
      }, `dir-row${collapsed ? '' : ' is-open'}`);
      dirBtn.style.setProperty('--depth', String(depth));
      dirBtn.setAttribute('aria-expanded', String(!collapsed));
      dirBtn.title = dir.path;
      dirBtn.dataset.path = dir.path;
      const dirLabel = el('span', dir.name, 'dir-name');
      dirBtn.append(chevronIcon('chevron'), folderIcon(), dirLabel);
      treeEl.append(dirBtn);
      if (!collapsed) appendTree(dir, depth + 1);
    }
    for (const entry of node.files) {
      const { file, index, name } = entry;
      renderedCount++;
      const c = state.counts[index] || count(file);
      const item = button('', () => goFile(index), 'file-link');
      item.style.setProperty('--depth', String(depth));
      item.dataset.path = file.newPath;
      item.dataset.index = String(index);
      item.title = file.newPath;
      const nameWrap = el('span', null, 'name');
      if (state.viewed.has(file.viewedKey)) {
        item.classList.add('is-viewed');
        nameWrap.append(el('span', '✓ ', 'check'));
      } else {
        nameWrap.append(el('span', '', `status-dot status-${file.status}`));
      }
      nameWrap.append(el('span', name, 'base'));
      const counts = el('span', null, 'counts');
      if (c.add > 0) counts.append(el('span', `+${c.add}`, 'add'));
      if (c.del > 0) { if (counts.childNodes.length) counts.append(' '); counts.append(el('span', `−${c.del}`, 'del')); }
      if (!counts.childNodes.length) counts.append(el('span', '+0', 'add'), ' ', el('span', '−0', 'del'));
      item.append(nameWrap, counts);
      treeEl.append(item);
    }
  }
  appendTree(tree, 0);
  if (filtering && renderedCount === 0) treeEl.append(el('div', 'No matching files', 'hint empty-filter'));

  const stats = el('div', null, 'sidebar-stats');
  const progressRow = el('div', null, 'stats-row');
  progressRow.append(el('span', `${viewed} of ${state.files.length} viewed`, 'hint progress'));
  const totalCounts = el('span', null, 'counts');
  totalCounts.append(el('span', `+${state.totals.add}`, 'add'), ' ', el('span', `−${state.totals.del}`, 'del'));
  progressRow.append(totalCounts);
  const bar = el('div', null, 'progress-bar');
  const fill = el('div', null, 'progress-fill');
  fill.style.width = state.files.length ? `${Math.round((viewed / state.files.length) * 100)}%` : '0%';
  bar.append(fill);
  stats.append(progressRow, bar);

  sidebar.querySelector('.file-tree')?.remove();
  sidebar.querySelector('.sidebar-stats')?.remove();
  sidebar.append(treeEl, stats);
  treeEl.scrollTop = prevTreeScroll;
  if (focused) treeEl.querySelector(`${focused.selector}[data-path="${CSS.escape(focused.path)}"]`)?.focus({ preventScroll: true });
  markCurrent();
}
function renderToolbar() {
  const segmented = el('div', null, 'segmented');
  segmented.setAttribute('role', 'group');
  segmented.setAttribute('aria-label', 'Diff layout');
  const unifiedBtn = button('', () => setSplit(false), `seg-btn${state.split ? '' : ' is-active'}`);
  unifiedBtn.append(unifiedIcon(), el('span', 'Unified'));
  unifiedBtn.setAttribute('aria-pressed', String(!state.split));
  const splitBtn = button('', () => setSplit(true), `seg-btn${state.split ? ' is-active' : ''}`);
  splitBtn.append(splitIcon(), el('span', 'Split'));
  splitBtn.setAttribute('aria-pressed', String(state.split));
  segmented.append(unifiedBtn, splitBtn);

  const wrapBtn = button('', toggleWrap, `tool-btn${state.wrap ? ' is-active' : ''}`);
  wrapBtn.append(wrapIcon(), el('span', 'Wrap'));
  wrapBtn.setAttribute('aria-pressed', String(state.wrap));
  wrapBtn.title = 'Toggle line wrapping (w)';

  const allCollapsed = state.files.length > 0 && state.files.every(file => isCollapsed(file.newPath));
  const foldBtn = button('', toggleCollapseAll, 'tool-btn');
  foldBtn.append(foldIcon(allCollapsed), el('span', allCollapsed ? 'Expand all' : 'Collapse all'));
  foldBtn.title = allCollapsed ? 'Expand all files' : 'Collapse all files';

  const helpBtn = button('?', () => { help.hidden = !help.hidden; }, 'tool-btn icon-only');
  helpBtn.setAttribute('aria-label', 'Keyboard shortcuts');
  helpBtn.title = 'Keyboard shortcuts (?)';

  toolbar.replaceChildren(segmented, wrapBtn, foldBtn, helpBtn);
  if (state.storageFailed) toolbar.append(el('span', 'Viewed resets on reload', 'hint'));
}
function setSplit(next) {
  if (state.split === next) return;
  state.split = next;
  view.setOptions(options());
  renderToolbar();
}
function toggleSplit() { setSplit(!state.split); }
function toggleWrap() { state.wrap = !state.wrap; view.setOptions(options()); renderToolbar(); }
const help = el('div', null, 'help'); help.hidden = true; app.append(help);
help.append(el('strong', 'Keyboard shortcuts'));
const keys = el('dl');
for (const [key, text] of [['j / k', 'next / previous file'], ['n / p', 'next / previous hunk'], ['v', 'mark the current file viewed'], ['c', 'collapse or expand current file'], ['s', 'toggle split view'], ['w', 'toggle line wrapping'], ['?', 'show or hide this help'], ['Esc', 'close this help']]) keys.append(el('dt', key), el('dd', text));
help.append(keys, button('Close', () => { help.hidden = true; }));
function goFile(index) {
  targetNotice.textContent = '';
  revealGeneration++;
  if (!state.files.length) return;
  state.current = Math.max(0, Math.min(index, state.files.length - 1));
  state.hunk = -1;
  markCurrent();
  view.scrollTo({ type: 'item', id: String(state.current), align: 'start', behavior: 'instant' });
}
function goHunk(delta) {
  const hunks = []; state.files.forEach((file, i) => file.parsed?.hunks?.forEach(h => hunks.push({ i, line: Math.max(1, h.additionStart || h.deletionStart), side: h.additionCount ? 'additions' : 'deletions' })));
  if (!hunks.length) return;
  let at = state.hunk + delta;
  if (state.hunk < 0) {
    at = delta > 0 ? hunks.findIndex(h => h.i >= state.current) : hunks.findLastIndex(h => h.i <= state.current);
    if (at < 0) at = delta > 0 ? hunks.length - 1 : 0;
  }
  state.hunk = Math.max(0, Math.min(at, hunks.length - 1)); const h = hunks[state.hunk]; state.current = h.i; markCurrent();
  view.scrollTo({ type: 'line', id: String(h.i), lineNumber: h.line, side: h.side, align: 'start', behavior: 'instant' });
}
document.addEventListener('keydown', event => {
  if (embedded && !app.isConnected) return;
  if (event.key === 'Escape' && !help.hidden) { help.hidden = true; return; }
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey && event.key !== '?' || event.composedPath().some(node => node instanceof Element && node.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))) return;
  const actions = {
    j: () => goFile(state.current + 1),
    k: () => goFile(state.current - 1),
    n: () => goHunk(1),
    p: () => goHunk(-1),
    v: () => toggleViewed(state.current),
    c: () => { const f = state.files[state.current]; if (f) toggleCollapsed(f, state.current); },
    s: toggleSplit,
    w: toggleWrap,
    '?': () => { help.hidden = !help.hidden; },
  };
  if (actions[event.key]) { event.preventDefault(); actions[event.key](); }
});
function closeDraft() {
  const draft = state.draft;
  state.draft = null;
  if (draft) {
    draft.box.remove();
    state.version++;
    view.updateItem(itemFor(state.files[draft.index], draft.index));
    view.clearSelectedLines();
  }
  updateNotice();
}
function openDraft(index, range) {
  const file = state.files[index], location = commentLocation(file, range, state.data.revision); if (!location) { notice.textContent = 'Select lines on one side of the diff.'; return; }
  if (state.draft?.textarea.value) return;
  closeDraft();
  const box = el('section', null, 'draft'), textarea = el('textarea'); textarea.placeholder = 'Write a comment'; textarea.setAttribute('aria-label', 'Write a comment');
  box.setAttribute('data-lavish-action', '');
  const where = `${location.side} ${location.where} (${location.revision})`; box.append(el('strong', where), textarea);
  const actions = el('div', null, 'draft-actions'), status = el('p', '', 'hint');
  const cancel = button('Cancel', closeDraft);
  let attempt = null;
  const queue = button('Queue comment', async () => {
    if (!textarea.value.trim() || queue.disabled) return;
    if (!window.lavish?.queuePromptAcknowledged) { status.textContent = 'Comments require an active, up-to-date Lavish session.'; return; }
    const data = state.data; queue.disabled = true; cancel.disabled = true;
    try {
      if (!attempt) {
        const digest = state.digest || await state.digestPromise;
        if (state.draft?.box !== box || state.data !== data) return;
        if (!digest) throw new Error('Could not identify the current diff');
        const quote = quoteSelection(file.parsed, range, file.fullFiles);
        const target = { type: 'diff-line', digest, fileIndex: index, oldPath: file.oldPath, newPath: file.newPath, side: range.side || 'additions', start: location.start, end: location.end, revision: String(data.revision || '') };
        const prefix = `${embedded ? `Hub view: Diff (diff)\nRevision range: ${data.range}\n\n` : ''}${where}\n\n${quote}\n\n`;
        const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
        attempt = { prompt: prefix + textarea.value, options: { tag: 'code-comment', text: where, queueKey: '', target, commentPrefix: prefix, requestId: `q-${random}` } };
      }
      textarea.readOnly = true;
      const result = await window.lavish.queuePromptAcknowledged(attempt.prompt, attempt.options);
      if (state.draft?.box !== box) return;
      if (result?.status === 'accepted') { const requestId = attempt.options.requestId; closeDraft(); window.lavish.releaseQueueRequest?.(requestId); return; }
      if (result?.status === 'rejected') {
        attempt = null; textarea.readOnly = false;
        const reasons = { reserved: 'A send is reserved; finish or retry it before queueing.', ended: 'This review has ended.', capacity: 'Too many queue requests are awaiting confirmation; finish them or reload the review.', too_large: 'This comment or its quoted context is too large; select fewer lines or shorten it.', rate_limited: 'Queueing is temporarily busy; wait a moment and retry.', invalid: 'The comment could not be validated.' };
        status.textContent = `${reasons[result.reason] || 'The comment could not be queued.'} Your draft is retained.`;
      } else {
        const reasons = { storage: 'The browser could not save the queue; free storage and retry.', rate_limited: 'Queueing is temporarily busy; wait a moment and retry this same request.', binding_changed: 'The review page changed; check the conversation before cancelling this draft.' };
        status.textContent = reasons[result?.reason] || 'Queue confirmation is uncertain. Retry to check, or check the conversation before cancelling.';
      }
    } catch (error) { status.textContent = `Could not queue comment: ${error.message}. Your draft is retained.`; }
    finally { queue.disabled = false; cancel.disabled = false; }
  });
  queue.title = 'Queue comment (⌘Enter)'; textarea.setAttribute('aria-keyshortcuts', 'Meta+Enter');
  actions.append(queue, cancel);
  box.append(status);
  box.append(actions); textarea.addEventListener('input', updateNotice);
  textarea.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing || event.repeat) return;
    event.preventDefault(); event.stopPropagation(); queue.click();
  });
  // The annotation reserves real row height, including on the opposite split
  // column. Retain the DOM node so virtual scrolling cannot discard its text.
  const annotation = { side: range.side || 'additions', lineNumber: Math.max(range.start, range.end), metadata: { box } };
  state.draft = { index, textarea, box, annotation };
  state.version++;
  view.updateItem(itemFor(file, index));
  view.clearSelectedLines();
  requestAnimationFrame(() => {
    if (state.draft?.box !== box) return;
    box.scrollIntoView({ block: 'nearest' });
    textarea.focus({ preventScroll: true });
  });
}
function updateNotice() {
  notice.replaceChildren(); if (!state.pending || state.pending === state.hash) return;
  notice.append('Diff changed. '); const refresh = button('Refresh', () => embedded ? applyEmbedded(state.pending) : loadData(state.pending)); refresh.disabled = Boolean(state.draft?.textarea.value); notice.append(refresh); if (refresh.disabled) notice.append(' Finish or cancel your comment first.');
}
function updateEmbeddedSummary() {
  if (!embedded) return;
  const titles = header.querySelector('.titles');
  if (!titles) return;
  const viewed = state.files.filter(file => state.viewed.has(file.viewedKey)).length;
  const counts = el('span', null, 'counts');
  counts.append(el('span', `+${state.totals.add}`, 'add'), ' ', el('span', `−${state.totals.del}`, 'del'));
  titles.replaceChildren(el('span', `${state.files.length} file${state.files.length === 1 ? '' : 's'}`, 'summary-files'), counts, el('span', `${viewed}/${state.files.length} viewed`, 'hint'));
}
function render(data) {
  revealGeneration++;
  clearTimeout(highlightTimer);
  targetNotice.textContent = '';
  expansionFailures = new Set();
  updateExpansionNotice();
  closeDraft();
  reportPlacements([]); state.digest = null; slots = [];
  const top = view.getScrollTop(), current = currentAt(top), previous = state.files[current]?.newPath, itemTop = view.getTopForItem(String(current)), offset = itemTop == null ? 0 : itemTop - top;
  state.data = data; state.version = (state.version || 0) + 1;
  state.files = modelPatch(data.patch);
  // Key CodeView's highlight and hydration cache by diff content plus pinned
  // range so returning to a visited range reuses highlights without sharing
  // hydrated unchanged-line context across different ranges.
  const rangeIdentity = data.rangeKey ?? data.range ?? '';
  state.files.forEach(file => { if (file.parsed) file.parsed.cacheKey = `${file.viewedKey}:${rangeIdentity}`; });
  state.counts = state.files.map(count);
  state.totals = state.counts.reduce((acc, c) => ({ add: acc.add + c.add, del: acc.del + c.del }), { add: 0, del: 0 });
  state.current = Math.max(0, state.files.findIndex(f => f.newPath === previous));

  const heading = el('div', null, 'heading'), titles = el('div', null, 'titles');
  if (!embedded) {
    const range = el('span', `${data.range} · ${data.rangeSource}`, 'range'); range.title = range.textContent;
    titles.append(el('h1', 'Diff review'), range, el('span', `Generated ${data.generated || 'unknown'}`, 'hint'));
  }
  heading.append(titles, toolbar); header.replaceChildren(heading);
  const commits = Array.isArray(data.commits) ? data.commits : data.commits ? String(data.commits).split('\n') : [];
  if (commits.length && !embedded) { const details = el('details', null, 'commits'); details.open = state.commitsOpen ?? commits.length <= 3; details.addEventListener('toggle', () => { state.commitsOpen = details.open; }); details.append(el('summary', `${commits.length} commit${commits.length === 1 ? '' : 's'}`), el('pre', commits.join('\n'))); header.append(details); }
  renderToolbar(); renderSidebar(); updateEmbeddedSummary(); setItems();
  if (previous && state.files[state.current]?.newPath === previous) view.scrollTo({ type: 'item', id: String(state.current), align: 'start', offset });
  else view.scrollTo({ type: 'position', position: top });
  if (!state.files.length) notice.textContent = `No changes in ${data.range}`; else updateNotice();
  state.digestPromise = diffDigest(data).then(digest => { if (state.data === data) { state.digest = digest; updateSlots(); } return digest; }).catch(() => { if (state.data === data) { state.digest = null; reportPlacements([]); } return null; });
}
let loadingHash;
function script(src, onerror) { const node = document.createElement('script'); node.src = src; node.onload = () => node.remove(); node.onerror = () => { node.remove(); onerror?.(); }; document.head.append(node); }
function loadData(hash) { if (loadingHash) return; loadingHash = hash; script(`./data-${encodeURIComponent(hash)}.js?t=${Date.now()}`, () => { loadingHash = null; notice.textContent = 'Could not load diff data; waiting for the next update.'; }); }
function applyEmbedded(data) { state.hash = data; state.pending = null; render(data); }
if (!embedded) {
  globalThis.lavishViewData = data => { state.hash = loadingHash; loadingHash = null; state.pending = state.latest !== state.hash ? state.latest : null; render(data); };
  globalThis.lavishViewLatest = hash => { state.latest = hash; if (!state.hash && !loadingHash) loadData(hash); else if (state.hash) { state.pending = hash !== state.hash ? hash : null; updateNotice(); } };
  function poll() { script(`./latest.js?t=${Date.now()}`); } poll(); if (!window.lavishPreview) setInterval(poll, 2000);
}
async function revealTarget(target) {
  const gen = ++revealGeneration, data = state.data;
  const isCurrent = () => gen === revealGeneration && state.data === data;
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const cancelled = () => ({ ok: false, reason: 'cancelled' });
  clearTimeout(highlightTimer);
  targetNotice.textContent = '';
  viewport.querySelectorAll('.file-header.deep-link-highlight').forEach(node => node.classList.remove('deep-link-highlight'));
  const entry = resolveFileEntry(state.files, target.file);
  if (!entry) { targetNotice.textContent = `File "${target.file}" is not in the current diff.`; return { ok: false, reason: 'missing-file' }; }
  const { file, index } = entry, id = String(index);
  if (isCollapsed(file.newPath)) {
    if (collapsedByDefault) state.expanded.add(file.newPath); else state.collapsed.delete(file.newPath);
    state.version++; view.updateItem(itemFor(file, index)); renderToolbar();
  }
  state.current = index; state.hunk = -1; markCurrent();
  const scrollFile = () => view.scrollTo({ type: 'item', id, align: 'start', behavior: 'instant' });
  const fail = (reason, message) => { scrollFile(); targetNotice.textContent = message; return { ok: false, reason }; };
  if (!target.line) {
    scrollFile(); await nextFrame(); if (!isCurrent()) return cancelled();
    const header = viewport.querySelector(`.file-header[data-file="${CSS.escape(file.newPath)}"]`);
    header?.classList.add('deep-link-highlight');
    highlightTimer = setTimeout(() => header?.classList.remove('deep-link-highlight'), 2500);
    return { ok: true };
  }
  const range = parseLineSpec(target.line);
  if (!range) return fail('invalid-line', `Invalid line target "${target.line}" for ${file.newPath}.`);
  if (!file.parsed || file.parseError || !file.parsed.hunks?.length) return fail('no-hunks', `Line ${target.line} cannot be shown for ${file.newPath} (no diff hunks).`);
  const side = resolveTargetSide(file, target.side), start = range.start;
  let end = range.end;
  if (!isRangeInHunks(file.parsed, start, end, side)) {
    if (file.status === 'added' || file.status === 'deleted') {
      const prefix = side === 'deletions' ? 'deletion' : 'addition';
      const maxLines = Math.max(0, ...file.parsed.hunks.map(h => h[`${prefix}Count`] > 0 ? h[`${prefix}Start`] + h[`${prefix}Count`] - 1 : 0));
      if (start > maxLines) return fail('line-out-of-bounds', `Line ${start} is outside ${file.newPath} (${maxLines} lines).`);
      end = Math.min(end, maxLines);
    } else {
      scrollFile(); await nextFrame(); if (!isCurrent()) return cancelled();
      const instance = view.idToItem.get(id)?.instance;
      try {
        if (!instance) throw new Error('unavailable');
        if (file.parsed.isPartial) {
          try { await instance.prepareForEditing(); }
          catch (error) {
            // Advanced virtualization installs the hydrated clone on the next layout pass.
            if (!instance.pendingHydratedDiff) throw error;
          }
          for (let frame = 0; frame < 5 && instance.pendingHydratedDiff; frame++) {
            await nextFrame();
            if (!isCurrent()) return cancelled();
          }
        }
        if (!isCurrent()) return cancelled();
        const contents = (side === 'deletions' ? file.fullFiles?.oldFile : file.fullFiles?.newFile)?.contents;
        const maxLines = fileLineCount(file.fullFiles, side);
        if (typeof contents === 'string' && start > maxLines) return fail('line-out-of-bounds', `Line ${start} is outside ${file.newPath} (${maxLines} lines).`);
        if (typeof contents === 'string') end = Math.min(end, maxLines);
        instance.revealLine(start, side); if (end !== start) instance.revealLine(end, side);
        await nextFrame(); if (!isCurrent()) return cancelled();
        if (file.parsed.isPartial || instance.isLineInCollapsedContext(start, side) || instance.isLineInCollapsedContext(end, side)) throw new Error('unavailable');
      } catch {
        if (!isCurrent()) return cancelled();
        return fail('expansion-unavailable', `Line ${target.line} is outside the diff hunks in ${file.newPath}, and unchanged lines could not be loaded.`);
      }
    }
  }
  view.scrollTo({ type: 'line', id, lineNumber: start, side, align: 'center', behavior: 'instant' });
  view.setSelectedLines({ id, range: { start, end, side } }, { notify: false });
  highlightTimer = setTimeout(() => {
    const selected = view.getSelectedLines();
    if (!state.draft && selected?.id === id && selected.range.start === start && selected.range.end === end && selected.range.side === side) view.clearSelectedLines({ notify: false });
  }, 2500);
  return { ok: true };
}
return { revealTarget, hasUnsavedDraft() { return Boolean(state.draft?.textarea.value); }, hide() { reportPlacements([]); }, update(data) { if (state.data && state.data.patch === data.patch && state.data.range === data.range && state.data.rangeKey === data.rangeKey && state.data.root === data.root && state.data.revision === data.revision) { state.data.operationId = data.operationId; state.data.snapshotVersion = data.snapshotVersion; state.pending = null; updateNotice(); schedulePlacements(); return; } if (state.draft?.textarea.value) { state.pending = data; updateNotice(); } else applyEmbedded(data); } };
}
if (document.querySelector('#app') && !globalThis.hubConfig) mountDiff(document.querySelector('#app'));
globalThis.mountLavishDiff = mountDiff;
