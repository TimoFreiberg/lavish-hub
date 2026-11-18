import { CodeView, getFiletypeFromFileName, registerCustomTheme } from '@pierre/diffs';
import { syntaxTheme, palette } from '../src/orangebox.mjs';
registerCustomTheme('orangebox', async () => syntaxTheme);
import { WorkerPoolManager } from '@pierre/diffs/worker';
import { modelPatch } from '../src/diff/model.mjs';
import { commentLocation, quoteSelection, zedCommand, zedUrl } from './locations.mjs';
import { diffDigest, matchesDiffAnchor } from './diff-anchors.mjs';

export function mountDiff(app, { embedded = false, loadDiffFiles } = {}) {
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
const button = (text, action) => { const node = el('button', text); node.type = 'button'; node.addEventListener('click', action); return node; };
const state = { data: null, files: [], hash: null, latest: null, pending: null, split: false, viewed: new Set(), collapsed: new Set(), current: 0, hunk: -1, draft: null, storageFailed: false };
if (!embedded) window.addEventListener('beforeunload', event => { if (state.draft?.textarea.value) { event.preventDefault(); event.returnValue = ''; } });
if (!window.lavishPreview) try { state.viewed = new Set(JSON.parse(localStorage.getItem('lavish-kit-viewed') || '[]')); } catch { state.storageFailed = true; }
const header = el('header', null, 'page-header'), toolbar = el('div', null, 'toolbar'), sidebar = el('nav', null, 'sidebar'), viewport = el('div', null, 'viewport'), notice = el('div', null, 'notice'), expansionNotice = el('div', null, 'notice');
expansionNotice.setAttribute('role', 'status');
// Lavish sees the shadow host, not the clicked diff line. Let CodeView handle
// this surface even when Lavish's annotation mode is active.
viewport.setAttribute('data-lavish-action', '');
const layout = el('div', null, 'layout'); layout.append(sidebar, viewport); app.append(header, toolbar, notice, expansionNotice, layout);
const gutterObservers = new WeakMap();
let view, worker, workerUrl, fallingBack = false;
let diffAnchors = [], slots = [], generation = null, placementFrame = 0;
const slotHeights = new Map();
function reportPlacements(placements) { if (generation !== null) window.lavish?.reportDiffPlacements?.(generation, placements); }
function schedulePlacements() {
  if (placementFrame) cancelAnimationFrame(placementFrame);
  placementFrame = requestAnimationFrame(() => {
    placementFrame = 0;
    if (!app.isConnected) return;
    const bounds = viewport.getBoundingClientRect();
    let clipTop = bounds.top;
    for (const header of viewport.querySelectorAll('.file-header')) {
      const rect = header.getBoundingClientRect();
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
// CodeView lays items out from itemMetrics without measuring headers, so the
// header must render at exactly this height or every later file drifts.
const HEADER_HEIGHT = 64;
function persist() { if (window.lavishPreview) return; try { localStorage.setItem('lavish-kit-viewed', JSON.stringify([...state.viewed])); } catch { state.storageFailed = true; renderToolbar(); } }
function makeWorker() {
  workerUrl = URL.createObjectURL(new Blob([LAVISH_KIT_WORKER_SOURCE], { type: 'text/javascript' }));
  return new WorkerPoolManager({ poolSize: 1, workerFactory: () => new Worker(workerUrl), onWorkerError: event => { event.preventDefault?.(); fallback(); } }, { theme: 'orangebox', themeType: 'dark', langs: [] });
}
function fallback() {
  if (fallingBack) return; fallingBack = true;
  try { worker?.terminate(); } catch {} worker = undefined;
  if (workerUrl) URL.revokeObjectURL(workerUrl);
  if (view) { const top = view.getScrollTop(); view.cleanUp(); createView(); setItems(); view.scrollTo({ type: 'position', position: top }); }
}
try { worker = makeWorker(); worker.initialize().catch(fallback); } catch { fallback(); }
function options() { return {
  theme: 'orangebox', themeType: 'dark', preferredHighlighter: 'shiki', diffStyle: state.split ? 'split' : 'unified', enableLineSelection: true,
  loadDiffFiles: async parsed => {
    const data = state.data, index = state.files.findIndex(file => file.parsed === parsed);
    try {
      if (!loadDiffFiles || !data?.operationId || index < 0) throw new Error('unavailable');
      const files = await loadDiffFiles(data.operationId, index);
      if (state.data === data) state.files[index].fullFiles = files;
      return files;
    } catch (error) {
      if (state.data === data) expansionNotice.textContent = 'Unchanged lines are unavailable for this file or snapshot. The original diff is still shown.';
      throw error;
    }
  },
  unsafeCSS: `:host { --diffs-addition-color-override: ${palette['diff-add']}; --diffs-deletion-color-override: ${palette['diff-del']}; --diffs-bg-addition-override: color-mix(in srgb, ${palette['diff-add']} 16%, ${palette.bg}); --diffs-bg-deletion-override: color-mix(in srgb, ${palette['diff-del']} 16%, ${palette.bg}); --diffs-bg-addition-emphasis-override: color-mix(in srgb, ${palette['diff-add']} 30%, ${palette.bg}); --diffs-bg-deletion-emphasis-override: color-mix(in srgb, ${palette['diff-del']} 30%, ${palette.bg}); }`,
  itemMetrics: { diffHeaderHeight: HEADER_HEIGHT }, stickyHeaders: true, pointerEventsOnScroll: true,
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
// Scroll only the sidebar; scrollIntoView would also scroll Lavish's parent page.
function markCurrent() {
  sidebar.querySelectorAll('.file-link').forEach((link, i) => {
    if (i !== state.current) { link.removeAttribute('aria-current'); return; }
    link.setAttribute('aria-current', 'true');
    const top = link.offsetTop - 40, bottom = link.offsetTop + link.offsetHeight + 8;
    if (top < sidebar.scrollTop) sidebar.scrollTop = top; else if (bottom > sidebar.scrollTop + sidebar.clientHeight) sidebar.scrollTop = bottom - sidebar.clientHeight;
  });
}
function count(file) { let add = 0, del = 0, inHunk = false; for (const line of file.raw.split('\n')) { if (line.startsWith('@@ ')) inHunk = true; else if (inHunk && line.startsWith('+')) add++; else if (inHunk && line.startsWith('-')) del++; } return { add, del }; }
function summary(file) {
  if (file.parseError) return `Could not parse: ${file.parseError}`;
  if (file.status === 'binary') return 'Binary file changed';
  if (file.status === 'mode-only') return `mode ${file.oldMode} → ${file.newMode}`;
  if (file.status === 'renamed' && !file.parsed?.hunks?.length) return `${file.oldPath} → ${file.newPath}, no content change`;
  const parts = [];
  if (file.status === 'type-change') parts.push(`Type changed (${file.oldMode} → ${file.newMode})`);
  if (file.oldMode === '120000' || file.newMode === '120000') parts.push('Symbolic link');
  if (file.status === 'added') parts.push('New file');
  if (file.status === 'deleted') parts.push('Deleted file');
  if (file.status === 'renamed') parts.push(`${file.oldPath} → ${file.newPath}`);
  return parts.join(' · ');
}
function toggleViewed(index) { const key = state.files[index]?.viewedKey; if (!key) return; state.viewed.has(key) ? state.viewed.delete(key) : state.viewed.add(key); persist(); renderSidebar(); setItems(); }
function toggleCollapsed(file) { state.collapsed.has(file.newPath) ? state.collapsed.delete(file.newPath) : state.collapsed.add(file.newPath); setItems(); }
async function copyText(text) { try { await navigator.clipboard.writeText(text); } catch { window.prompt('Copy command', text); } }
function showRaw(file) { const dialog = el('dialog', null, 'raw-dialog'); dialog.append(el('strong', file.newPath), el('pre', file.raw, 'raw'), button('Close', () => dialog.close())); dialog.addEventListener('close', () => dialog.remove()); app.append(dialog); dialog.showModal(); }
function fileHeader(index) {
  const file = state.files[index]; if (!file) return el('div');
  const box = el('div', null, 'file-header'); box.dataset.file = file.newPath; box.style.height = `${HEADER_HEIGHT}px`;
  const line = el('div', null, 'file-title'), collapsed = state.collapsed.has(file.newPath);
  const toggle = button(collapsed ? '▶' : '▼', () => toggleCollapsed(file)); toggle.className = 'icon'; toggle.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${file.newPath}`); toggle.setAttribute('aria-expanded', String(!collapsed));
  const title = el('strong', file.newPath, 'path'); title.title = file.newPath;
  const c = count(file), counts = el('span', null, 'counts'); counts.append(el('span', `+${c.add}`, 'add'), ' ', el('span', `−${c.del}`, 'del'));
  const label = el('label', null, 'viewed'), check = el('input'); check.type = 'checkbox'; check.checked = state.viewed.has(file.viewedKey); check.addEventListener('change', () => toggleViewed(index)); label.append(check, ' Viewed');
  line.append(toggle, title, counts, label); box.append(line);
  const row = el('div', null, 'file-actions'), description = summary(file);
  if (description) { const text = el('span', description, 'file-description'); text.title = description; row.append(text); }
  if (file.parseError) row.append(button('Show raw patch', () => showRaw(file)));
  const hunks = file.parsed?.hunks || [];
  if (hunks.length) {
    const side = file.status === 'deleted' ? 'deletions' : 'additions', path = side === 'deletions' ? file.oldPath : file.newPath;
    const links = el('span', null, 'zed-links');
    for (const hunk of hunks) {
      const lineNumber = Math.max(1, side === 'deletions' ? hunk.deletionStart : hunk.additionStart);
      const link = el('a', 'Open in Zed'); link.href = window.lavishPreview ? '#' : zedUrl(state.data.root, path, lineNumber); if (window.lavishPreview) link.onclick = event => { event.preventDefault(); notice.textContent = 'Opening an editor is unavailable in the demo.'; }; link.target = '_blank'; link.rel = 'noopener'; link.setAttribute('aria-label', `Open in Zed :${lineNumber}`);
      const copy = button('⧉', () => copyText(zedCommand(state.data.root, path, lineNumber))); copy.className = 'icon small'; copy.title = `Copy Zed command :${lineNumber}`; copy.setAttribute('aria-label', copy.title);
      const group = el('span', null, 'zed-link'); group.append(link, copy); links.append(group);
    }
    row.append(links);
  }
  box.append(row);
  return box;
}
const supportedLanguages = new Set(LAVISH_KIT_LANGUAGES);
function itemFor(file, index) {
  if (file.parsed && !file.parseError) { const lang = getFiletypeFromFileName(file.parsed.name); file.parsed.lang = supportedLanguages.has(lang) ? lang : 'text'; return { id: String(index), type: 'diff', fileDiff: file.parsed, version: state.version, collapsed: state.collapsed.has(file.newPath), annotations: [...slots.filter(slot => slot.index === index).map(slot => slot.annotation), ...(state.draft?.index === index ? [state.draft.annotation] : [])] }; }
  return { id: String(index), type: 'file', file: { name: file.newPath, contents: '' }, collapsed: true };
}
function setItems() { state.version = (state.version || 0) + 1; if (view) view.setItems(state.files.map(itemFor)); }
function renderSidebar() {
  const focused = [...sidebar.querySelectorAll('.file-link')].indexOf(document.activeElement);
  const viewed = state.files.filter(file => state.viewed.has(file.viewedKey)).length;
  sidebar.replaceChildren(el('h2', `Files (${state.files.length})`), el('div', `${viewed} of ${state.files.length} viewed`, 'hint progress'));
  state.files.forEach((file, i) => {
    const c = count(file), item = button('', () => goFile(i)), name = el('span', null, 'name'), slash = file.newPath.lastIndexOf('/');
    item.className = 'file-link'; item.dataset.path = file.newPath; item.title = file.newPath;
    if (state.viewed.has(file.viewedKey)) { item.classList.add('is-viewed'); name.append(el('span', '✓ ', 'check')); }
    if (slash >= 0) { const dir = el('span', null, 'dir'); for (const part of file.newPath.slice(0, slash).split('/')) dir.append(`${part}/`, el('wbr')); name.append(dir); }
    name.append(el('span', file.newPath.slice(slash + 1), 'base'));
    const counts = el('span', null, 'counts'); counts.append(el('span', `+${c.add}`, 'add'), ' ', el('span', `−${c.del}`, 'del'));
    item.append(name, counts); sidebar.append(item);
  });
  if (focused >= 0) sidebar.querySelectorAll('.file-link')[focused]?.focus({ preventScroll: true });
  markCurrent();
}
function renderToolbar() {
  toolbar.replaceChildren(button(state.split ? 'Unified' : 'Split', toggleSplit), button('Keyboard shortcuts (?)', () => help.hidden = !help.hidden));
  if (state.storageFailed) toolbar.append(el('span', 'Viewed resets on reload', 'hint'));
}
function toggleSplit() { state.split = !state.split; view.setOptions(options()); renderToolbar(); }
const help = el('div', null, 'help'); help.hidden = true; app.append(help);
help.append(el('strong', 'Keyboard shortcuts'));
const keys = el('dl'); for (const [key, text] of [['j / k', 'next / previous file'], ['n / p', 'next / previous hunk'], ['v', 'mark the current file viewed'], ['s', 'toggle split view'], ['?', 'show or hide this help'], ['Esc', 'close this help']]) keys.append(el('dt', key), el('dd', text));
help.append(keys, button('Close', () => help.hidden = true));
function goFile(index) { if (!state.files.length) return; state.current = Math.max(0, Math.min(index, state.files.length - 1)); state.hunk = -1; markCurrent(); view.scrollTo({ type: 'item', id: String(state.current), align: 'start' }); }
function goHunk(delta) {
  const hunks = []; state.files.forEach((file, i) => file.parsed?.hunks?.forEach(h => hunks.push({ i, line: Math.max(1, h.additionStart || h.deletionStart), side: h.additionCount ? 'additions' : 'deletions' })));
  if (!hunks.length) return;
  let at = state.hunk + delta;
  if (state.hunk < 0) {
    at = delta > 0 ? hunks.findIndex(h => h.i >= state.current) : hunks.findLastIndex(h => h.i <= state.current);
    if (at < 0) at = delta > 0 ? hunks.length - 1 : 0;
  }
  state.hunk = Math.max(0, Math.min(at, hunks.length - 1)); const h = hunks[state.hunk]; state.current = h.i; markCurrent(); view.scrollTo({ type: 'line', id: String(h.i), lineNumber: h.line, side: h.side, align: 'start' });
}
document.addEventListener('keydown', event => { if (embedded && !app.isConnected) return; if (event.key === 'Escape' && !help.hidden) { help.hidden = true; return; } if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey && event.key !== '?' || event.composedPath().some(node => node instanceof Element && node.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))) return; const actions = { j: () => goFile(state.current + 1), k: () => goFile(state.current - 1), n: () => goHunk(1), p: () => goHunk(-1), v: () => toggleViewed(state.current), s: toggleSplit, '?': () => help.hidden = !help.hidden }; if (actions[event.key]) { event.preventDefault(); actions[event.key](); } });
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
        const prefix = `${embedded ? `Hub view: Changes (changes)\nRevision range: ${data.range}\n\n` : ''}${where}\n\n${quote}\n\n`;
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
function render(data) {
  expansionNotice.textContent = '';
  closeDraft();
  reportPlacements([]); state.digest = null; slots = [];
  const top = view.getScrollTop(), current = currentAt(top), previous = state.files[current]?.newPath, itemTop = view.getTopForItem(String(current)), offset = itemTop == null ? 0 : itemTop - top; state.data = data; state.version = (state.version || 0) + 1; state.files = modelPatch(data.patch); state.current = Math.max(0, state.files.findIndex(f => f.newPath === previous));
  const heading = el('div', null, 'heading'), titles = el('div', null, 'titles'); const range = el('span', `${data.range} · ${data.rangeSource}`, 'range'); range.title = range.textContent; titles.append(el('h1', 'Diff review'), range, el('span', `Generated ${data.generated || 'unknown'}`, 'hint')); heading.append(titles, toolbar); header.replaceChildren(heading);
  const commits = Array.isArray(data.commits) ? data.commits : data.commits ? String(data.commits).split('\n') : [];
  if (commits.length) { const details = el('details', null, 'commits'); details.open = state.commitsOpen ?? commits.length <= 3; details.addEventListener('toggle', () => { state.commitsOpen = details.open; }); details.append(el('summary', `${commits.length} commit${commits.length === 1 ? '' : 's'}`), el('pre', commits.join('\n'))); header.append(details); }
  renderToolbar(); renderSidebar(); setItems(); if (previous && state.files[state.current]?.newPath === previous) view.scrollTo({ type: 'item', id: String(state.current), align: 'start', offset }); else view.scrollTo({ type: 'position', position: top });
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
return { hasUnsavedDraft() { return Boolean(state.draft?.textarea.value); }, hide() { reportPlacements([]); }, update(data) { if (state.data && state.data.patch === data.patch && state.data.range === data.range && state.data.root === data.root && state.data.revision === data.revision) { state.data.operationId = data.operationId; state.pending = null; updateNotice(); schedulePlacements(); return; } if (state.draft?.textarea.value) { state.pending = data; updateNotice(); } else applyEmbedded(data); } };
}
if (document.querySelector('#app') && !globalThis.hubConfig) mountDiff(document.querySelector('#app'));
globalThis.mountLavishDiff = mountDiff;
