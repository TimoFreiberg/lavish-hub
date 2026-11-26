const config = globalThis.hubConfig;
if (config.url.startsWith('/')) config.url = new URL(config.url, location.href).href;
const app = document.querySelector('#app');
const drafts = new Map();
const diffContainer = document.createElement('div'); diffContainer.className = 'hub-diff';
let diffView;
const bundleLoads = new Map();
// A load attempt serves every view that asks for it while it runs, so a render
// that abandons one does not start a second; only a settled failure is retried.
function loadBundle(name, globalName) {
  if (typeof globalThis[globalName] === 'function') return Promise.resolve();
  if (bundleLoads.has(name)) return bundleLoads.get(name);
  const loading = attemptBundle(name, globalName).catch(error => { bundleLoads.delete(name); throw error; });
  bundleLoads.set(name, loading);
  return loading;
}
function attemptBundle(name, globalName) {
  const reference = document.querySelector(`audio[data-hub-bundle="${name}"]`);
  if (!reference?.src) return Promise.reject(new Error(`Missing ${name} renderer`));
  const source = new URL(reference.src);
  const href = source.href;
  return new Promise((resolve, reject) => {
    let settled = false, script, objectUrl, request;
    // The deadline covers the bytes, not just the response head, and cancelling
    // is what ends the transfer: a removed script element keeps its request alive
    // and can hold the connection a retry of the same URL needs.
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      request?.abort();
      if (script) { script.onload = null; script.onerror = null; script.remove(); }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`Could not load ${name} renderer`)), 10000);
    // The renderer runs from this document either way, so a bundle is only ever
    // executed as a whole: a partial body is not something a script can act on.
    const execute = url => {
      script = document.createElement('script');
      script.onload = () => finish(typeof globalThis[globalName] === 'function' ? null : new Error(`Invalid ${name} renderer`));
      script.onerror = () => finish(new Error(`Could not load ${name} renderer`));
      script.src = url;
      document.head.append(script);
    };
    // An exported page inlines its renderer as a data URL, and a page opened
    // straight from disk loads it through the file scheme. Neither can be fetched,
    // so those two keep the plain script load that works offline; any other scheme
    // is refused rather than executed. Spell the schemes out only in code: export
    // reads the file scheme in this inlined script, comments included, as a local
    // reference and rewrites it.
    if (!/^https?:$/.test(source.protocol)) {
      if (!/^(?:data|file):$/.test(source.protocol)) return finish(new Error(`Could not load ${name} renderer`));
      execute(href);
      return;
    }
    request = new AbortController();
    fetch(href, { credentials: 'omit', redirect: 'error', signal: request.signal })
      .then(response => {
        if (!response.ok || !/^(?:text|application)\/(?:x-)?(?:java|ecma)script\b/i.test(response.headers.get('content-type') || '')) throw new Error(`Could not load ${name} renderer`);
        // Every type accepted above is a JavaScript MIME type, so the blob keeps a
        // type the script loader runs and the body is not copied into a second one.
        return response.blob();
      })
      .then(blob => {
        if (settled) return;
        objectUrl = URL.createObjectURL(blob);
        execute(objectUrl);
      })
      .catch(() => finish(new Error(`Could not load ${name} renderer`)));
  });
}
async function requireBundle(name, globalName, view, generation) {
  try { await loadBundle(name, globalName); }
  catch (error) {
    if (generation === renderGeneration) view.append(notice(error.message), button('Retry', () => renderView()));
    return false;
  }
  return generation === renderGeneration;
}
let selected = 'diff', snapshot, documents = [], busy = false;
const initialParams = new URLSearchParams(location.search);
let initialView = initialParams.get('__lavish_hub_view') || initialParams.get('view') || '';
const initialTarget = name => initialParams.get(`__lavish_hub_${name}`) || initialParams.get(name) || '';
let pendingDeepLink = initialView ? { view: initialView, file: initialTarget('file'), line: initialTarget('line'), side: initialTarget('side'), change: initialTarget('change') } : null;
let pendingDeepLinkNotice = '';
if (initialView) {
  for (const name of ['view', 'file', 'line', 'side', 'change']) { initialParams.delete(name); initialParams.delete(`__lavish_hub_${name}`); }
  const search = initialParams.toString();
  history.replaceState(history.state, '', location.pathname + (search ? `?${search}` : '') + location.hash);
}
function parseHubDeepLink(href) {
  if (typeof href !== 'string' || !/^(?:hub\.html)?\?/.test(href)) return null;
  const url = new URL(href, 'https://hub.invalid/'), view = url.searchParams.get('view') || '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(view)) return null;
  return { view, file: url.searchParams.get('file') || '', line: url.searchParams.get('line') || '', side: url.searchParams.get('side') || '', change: url.searchParams.get('change') || '' };
}
const repoName = config.repoName || config.workspaceName || config.workspace?.split(/[\\/]/).filter(Boolean).pop() || '';
let sessionTitle = config.sessionTitle || '';
const identityName = () => config.session || sessionTitle ? repoName : (config.workspaceName || repoName);
const frames = new Map();
let refreshTimer, rendered = false, warmed = false, refreshRequested = false, snapshotForce = false, snapshotRequest = 0, snapshotApplied = 0, snapshotQueued = false, snapshotPreflightFailed = false, snapshotUnrendered = false;
// Loading is an intent that belongs to a snapshot request, not to whichever refresh
// happens to be running: a view entered while a document refresh is in flight owes a
// request that refresh never issues, and only settling a request can end the notice.
// A queued intent covers the gap before the request exists; the generation gap covers
// the request itself, so a refresh that skips the snapshot cannot end either. An owed
// request whose status and documents preflight failed is not being fetched, so it must
// say the snapshot is unavailable instead of claiming to load it.
const snapshotLoading = () => (snapshotQueued && !snapshotPreflightFailed) || snapshotApplied < snapshotRequest;
let modeView;
const startsInExplore = id => id === 'diff';
// Only the repository views render a snapshot, and a snapshot costs several jj
// runs per request, so only those views ask for one. Status and documents keep
// polling on every view.
const needsSnapshot = startsInExplore;
window.addEventListener('lavish:ready', () => { if (startsInExplore(modeView)) globalThis.lavish?.setAnnotationMode?.(false); updateTabTitle(); if (lastReplaceUrl) syncUrl(lastReplaceUrl); });
const labels = { diff: 'Diff', tasks: 'Tasks' };
const labelFor = id => Object.hasOwn(labels, id) ? labels[id] : undefined;
let pendingHash = location.hash || null, currentViewHash = location.hash, lastReplaceUrl = null, queuedUrlChange = null;
function syncUrl(update) {
  if (update.mode === 'replace') lastReplaceUrl = update;
  else lastReplaceUrl = null;
  if (globalThis.lavish?.syncUrl) globalThis.lavish.syncUrl(update);
  else if (window.self === window.top && location.protocol !== 'about:') {
    const url = new URL(location.href); url.searchParams.set('view', update.view); url.hash = update.hash;
    const next = url.pathname + url.search + url.hash;
    if (next !== location.pathname + location.search + location.hash) history[update.mode === 'push' ? 'pushState' : 'replaceState'](null, '', next);
  }
}
function replaceFrameHash(hash) {
  if (window.self !== window.top) history.replaceState(null, '', location.pathname + location.search + hash);
}
function scrollToFragment(hash) {
  let id;
  try { id = decodeURIComponent(hash.slice(1)); } catch { id = hash.slice(1); }
  if (!id || id === 'top') { window.scrollTo(0, 0); return; }
  const view = document.querySelector('#view');
  const target = [...view.querySelectorAll('[id], [name]')].find(node => node.id === id || node.getAttribute('name') === id)
    || document.getElementById(id) || document.getElementsByName(id)[0];
  target?.scrollIntoView();
}
for (const type of ['wheel', 'pointerdown', 'keydown', 'touchstart']) document.addEventListener(type, event => { if (event.isTrusted) pendingHash = null; }, true);
document.addEventListener('click', event => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest?.('#view a[href^="#"]');
  if (!link || link.closest('[data-lavish-action],[data-lavish-ui]') || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
  const hash = link.getAttribute('href'); event.preventDefault(); pendingHash = hash; currentViewHash = hash;
  replaceFrameHash(hash); syncUrl({ view: selected, hash, mode: 'push' }); scrollToFragment(hash);
});
const { formatTabTitle, applyNavBadge, applyCollapseToggle, createLeaveGuard, createOlderDisclosureController, createSafeStorage, attachResizablePane } = globalThis.lavishHubLifecycle;
function updateTabTitle() {
  const title = formatTabTitle('', sessionTitle || repoName);
  document.title = title;
  globalThis.lavish?.setDocumentMeta?.({ title });
}
let displayedDoc = null, ackInFlight = '';
function acknowledgeDisplayed(id, version) {
  if (!id || !version) return;
  const doc = documents.find(item => item.id === id);
  if (!doc || doc.version !== version) return;
  if (doc.viewedVersion === version) return;
  const key = `${id}\0${version}`;
  if (ackInFlight === key) return;
  ackInFlight = key;
  action('acknowledge', { id, version }).then(cleared => {
    if (!cleared) return;
    const current = documents.find(item => item.id === id);
    if (current && current.version === version) { current.viewedVersion = version; renderNav(); }
  }).catch(() => {}).finally(() => { if (ackInFlight === key) ackInFlight = ''; });
}
const el = (tag, text, attrs = {}) => { const node = document.createElement(tag); if (text != null) node.textContent = text; for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); return node; };
const button = (text, action) => { const node = el('button', text, { type: 'button' }); node.addEventListener('click', action); return node; };
function editButton(label, action) {
  const edit = button('', action); edit.className = 'commit-edit'; edit.setAttribute('aria-label', `Edit ${label}`); edit.title = `Edit ${label}`;
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M4 20l4-.8L19 8.2 15.8 5 4.8 16 4 20zm10.6-13.8l3.2 3.2');
  icon.append(path); edit.append(icon); return edit;
}
async function action(operation, body = {}) {
  let response;
  try { response = await fetch(`${config.url}/action`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lavish-capability': config.capability }, body: JSON.stringify({ ...body, operation }), ...(['status', 'documents', 'snapshot', 'readDocument', 'diffFiles', 'diffRange', 'navigate', 'acknowledge', 'setDocumentCollapsed'].includes(operation) ? { signal: AbortSignal.timeout(10000) } : {}) }); }
  catch { throw new Error('Hub actions are unreachable. Your edits remain on this page. Local actions require the running hub owner.'); }
  const data = await response.json();
  leaveGuard.handleUnauthorized(response, data);
  if (!response.ok) throw new Error(data.error === 'Unauthorized' ? ownerRestartedMessage : data.error || 'Action failed');
  return data.result;
}
const ownerRestartedMessage = 'The hub owner restarted. Reload this page to reconnect; unsaved drafts on it would be lost.';
let navigationError = '', connectionStatus = 'Connecting…';
function status(text) {
  connectionStatus = text;
  const notice = leaveGuard.isUncertain() ? 'Navigation may still be in progress; select a destination to continue' : '';
  const connection = (navigationError || notice) && ['Connected', 'Connecting…'].includes(connectionStatus) ? '' : connectionStatus;
  document.querySelector('#connection').textContent = [navigationError, connection, notice].filter(Boolean).join(' · ');
}
const olderDisclosure = createOlderDisclosureController();
let collapseRevision = 0, pinnedPrimaryId = null, lastRenderedSelected = null;
const isCollapsedForSidebar = doc => Boolean(doc?.collapsed) && doc.id !== pinnedPrimaryId;
async function toggleDocumentCollapsed(id, toggle) {
  const doc = documents.find(item => item.id === id);
  if (!doc?.version) return;
  const collapsed = !isCollapsedForSidebar(doc), version = doc.version;
  toggle.disabled = true; collapseRevision++;
  try {
    await action('setDocumentCollapsed', { id, version, collapsed });
    const current = documents.find(item => item.id === id && item.version === version);
    if (current) current.collapsed = collapsed;
    if (collapsed && pinnedPrimaryId === id) pinnedPrimaryId = null;
    else if (!collapsed && id === selected) pinnedPrimaryId = id;
    collapseRevision++; renderNav(); toggle.disabled = false;
    if (toggle.isConnected && !toggle.closest('details:not([open])')) toggle.focus();
    else document.querySelector('#navigation .nav-older summary')?.focus();
  } catch (error) { status(error.message); }
  finally { toggle.disabled = false; }
}
function renderNav() {
  const nav = document.querySelector('#navigation');
  const focused = nav.contains(document.activeElement) ? document.activeElement : null;
  if (selected !== lastRenderedSelected) { pinnedPrimaryId = null; lastRenderedSelected = selected; }
  const activeDoc = documents.find(doc => doc.id === selected);
  if (activeDoc && !activeDoc.collapsed) pinnedPrimaryId = selected;
  let primary = nav.querySelector('.nav-primary'), details = nav.querySelector('.nav-older');
  if (!primary) { primary = el('div', null, { class: 'nav-primary' }); nav.append(primary); }
  if (!details) {
    details = el('details', null, { class: 'nav-older' });
    const summary = el('summary'); summary.append('Older (', el('span', '0', { class: 'nav-older-count' }), ')');
    details.append(summary, el('div', null, { class: 'nav-older-list' })); nav.append(details);
    details.addEventListener('toggle', () => olderDisclosure.onUserToggle(details));
  }
  const older = details.querySelector('.nav-older-list');
  const existing = new Map([...nav.querySelectorAll('button[data-hub-id]')].map(b => [b.dataset.hubId, b]));
  const items = [...Object.entries(labels).map(([id, label]) => ({ id, label })), ...documents.map(doc => ({ ...doc, label: doc.title, unseen: doc.viewedVersion !== doc.version, collapsed: isCollapsedForSidebar(doc) }))];
  const next = new Map([[primary, primary.firstElementChild], [older, older.firstElementChild]]);
  for (const item of items) {
    let b = existing.get(item.id);
    if (!b) { b = button('', () => select(item.id)); b.dataset.hubId = item.id; }
    else existing.delete(item.id);
    let label = b.querySelector('.nav-label');
    if (!label) { label = el('span', item.label, { class: 'nav-label' }); b.replaceChildren(label); }
    else if (label.textContent !== item.label) label.textContent = item.label;
    applyNavBadge(b, item.unseen ? 'new' : '', 'hub-nav-desc');
    if (item.id === selected) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    let node = b;
    if (!Object.hasOwn(labels, item.id) && item.version) {
      let row = b.parentElement?.classList.contains('nav-row') ? b.parentElement : null;
      if (!row) { row = el('div', null, { class: 'nav-row' }); row.append(b); const toggle = button('', () => toggleDocumentCollapsed(item.id, toggle)); toggle.className = 'nav-collapse-toggle'; row.append(toggle); }
      const toggle = row.querySelector('.nav-collapse-toggle');
      applyCollapseToggle(toggle, item.label, item.collapsed); node = row;
    }
    const target = item.collapsed ? older : primary;
    const previous = node.parentElement;
    if (previous !== target && next.get(previous) === node) next.set(previous, node.nextElementSibling);
    const before = next.get(target);
    if (node !== before) target.insertBefore(node, before);
    next.set(target, node.nextElementSibling);
  }
  for (const b of existing.values()) (b.closest('.nav-row') || b).remove();
  const count = documents.filter(isCollapsedForSidebar).length;
  details.querySelector('.nav-older-count').textContent = String(count);
  olderDisclosure.sync(details, { count, activeOlderId: documents.find(doc => doc.id === selected && isCollapsedForSidebar(doc))?.id || null });
  if (focused?.isConnected) {
    const closed = focused.closest('details:not([open])');
    if (closed) closed.querySelector('summary')?.focus();
    else if (document.activeElement !== focused) focused.focus();
  }
}
let navigationRevision = 0, navigationPending = false, editRevision = 0;
let lastSelectionRevision = null;
let ownerNavigation = Promise.resolve(), refreshPaused = false, refreshPauseRevision = 0;
const seenDocs = new Map();
let notificationBaseline = false, toastTimer;
const toast = el('div', null, { id: 'hub-toast', 'data-lavish-action': '', role: 'status', 'aria-live': 'polite' });
toast.hidden = true; document.body.append(toast);
function hideToast() { clearTimeout(toastTimer); toast.hidden = true; }
function showToast(id, label) {
  clearTimeout(toastTimer); toast.replaceChildren(el('span', label));
  const open = button('Open', () => { hideToast(); select(id); });
  const dismiss = button('×', hideToast); dismiss.setAttribute('aria-label', 'Dismiss notification');
  toast.append(open, dismiss); toast.hidden = false; toastTimer = setTimeout(hideToast, 6000);
}
function noteUpdates(state, list) {
  let notice;
  for (const doc of list) {
    const previous = seenDocs.get(doc.id);
    if (notificationBaseline && doc.id !== selected) {
      const kind = !previous ? 'New' : previous.version !== doc.version ? 'Updated' : '';
      if (kind) notice = { id: doc.id, label: `${kind}: ${doc.title}` };
    }
    seenDocs.set(doc.id, { version: doc.version });
  }
  const selectionTarget = state.selectionTarget ?? state.selected;
  if (notificationBaseline && !notice && !leaveGuard.isLeaving() && state.selectionRevision > lastSelectionRevision && selectionTarget && selectionTarget !== selected) {
    const title = labelFor(selectionTarget) || list.find(doc => doc.id === selectionTarget)?.title || selectionTarget;
    notice = { id: selectionTarget, label: `Selected: ${title}` };
  }
  if (typeof state.selectionRevision === 'number') lastSelectionRevision = Math.max(lastSelectionRevision ?? state.selectionRevision, state.selectionRevision);
  notificationBaseline = true;
  if (notice) showToast(notice.id, notice.label);
}
// A hidden tab keeps no poll timer. This is scheduler state only: page-leaving
// pauses (refreshPaused), drafts, and annotation mode keep their own guards.
let tabHidden = document.visibilityState === 'hidden';
// One follow-up is owed to whichever scheduler event asked for it. A forced snapshot
// is tracked apart from that queue and spent only by the request it forces: a refresh
// whose status or documents preflight pauses or fails first owes the uncached snapshot
// to the next poll rather than dropping back to cached content.
function queueRefresh() { refreshRequested = true; }
function pauseRefresh() { refreshPaused = true; clearTimeout(refreshTimer); return ++refreshPauseRevision; }
function resumeRefresh() {
  if (!refreshPaused) return;
  if (startsInExplore(selected)) globalThis.lavish?.setAnnotationMode?.(false);
  refreshPaused = false;
  if (busy) queueRefresh();
  else refreshTimer = setTimeout(refresh, 0);
}
// Entering a repository view must not wait for the next poll to ask for its
// snapshot. A refresh already in flight renders the new selection itself, so ask
// for a follow-up instead of polling twice at once. A paused or hidden page keeps
// that follow-up for its own catch-up rather than dropping the request.
function requestRefresh() {
  if (busy || refreshPaused || tabHidden) { queueRefresh(); return; }
  refresh();
}
document.addEventListener('visibilitychange', () => {
  const hidden = document.visibilityState === 'hidden';
  if (hidden === tabHidden) return;
  tabHidden = hidden;
  clearTimeout(refreshTimer);
  // Page-leaving pauses resume their own work, and a running refresh reschedules
  // from its own finally block. Only the scheduler catches up here.
  if (hidden || refreshPaused) return;
  if (busy) { queueRefresh(); return; }
  refresh();
});
const leaveGuard = createLeaveGuard({
  isDirty: hasUnsavedDrafts, onPause: pauseRefresh,
  onResume: () => { resumeRefresh(); if (!navigationPending && queuedUrlChange) { const next = queuedUrlChange; queuedUrlChange = null; handleUrlChange(next); } },
  onStatus: () => { if (leaveGuard.isCancelled()) navigationError = 'Navigation cancelled. Select a destination to try again.'; status(connectionStatus); },
});
function synchronizeNavigation(id) {
  const request = ownerNavigation.then(() => action('navigate', { id }));
  ownerNavigation = request.catch(() => {});
  return request;
}
for (const type of ['input', 'change']) document.addEventListener(type, event => { if (event.isTrusted) editRevision++; }, true);
function hasUnsavedDrafts() {
  return Boolean(diffView?.hasUnsavedDraft()) || [...drafts.values()].some(state => state.saving || state.text !== state.original);
}
async function select(id, { hash = '', fromPopstate = false, deepLink = false } = {}) {
  if (!deepLink) { pendingDeepLink = null; pendingDeepLinkNotice = ''; }
  const currentHash = currentViewHash;
  const doc = documents.find(item => item.id === id);
  const leavesPage = doc?.sibling && doc.source?.toLowerCase().endsWith('.html');
  if (navigationPending || leaveGuard.isLeaving()) return;
  leaveGuard.clearCancelled(); navigationError = ''; status(connectionStatus);
  navigationPending = true;
  if (leavesPage) pauseRefresh();
  const revision = ++navigationRevision;
  try {
    if (!leavesPage) {
      selected = id; currentViewHash = hash; pendingHash = hash || (fromPopstate ? '' : null); replaceFrameHash(hash);
      if (!fromPopstate) syncUrl({ view: id, hash, mode: 'push' });
      renderNav();
      // A stale snapshot keeps rendering, but the view marks it as refreshing until
      // the request below replaces it, and a missing one shows its loading state.
      if (needsSnapshot(id)) { snapshotQueued = true; snapshotPreflightFailed = false; }
      const synchronization = synchronizeNavigation(id).then(() => {
        if (revision === navigationRevision) { leaveGuard.clearUncertain(); navigationError = ''; status(connectionStatus); }
      }, error => {
        if (revision === navigationRevision) { navigationError = error.message; status(connectionStatus); }
      });
      navigationPending = false;
      // Polling skips the snapshot on non-repository views, so entering one asks
      // for a current snapshot now instead of waiting for the next poll. A failed
      // earlier snapshot is retried the same way.
      if (needsSnapshot(id)) requestRefresh();
      await renderViewKeepingFocus();
      await synchronization;
      return;
    }
    const approved = await leaveGuard.confirmTwice('Leaving discards unsaved hub drafts and unqueued comments.', () => editRevision, async () => { await synchronizeNavigation(id); return revision === navigationRevision; });
    if (!approved || revision !== navigationRevision) return;
    const modeEditRevision = editRevision;
    if (modeView && startsInExplore(modeView)) await globalThis.lavish?.setAnnotationMode?.(true);
    if (revision !== navigationRevision) return;
    if (modeEditRevision !== editRevision && hasUnsavedDrafts() && !(await globalThis.confirmDraftNavigation('Leaving discards unsaved hub drafts and unqueued comments.'))) return;
    if (queuedUrlChange) return;
    leaveGuard.clearUncertain(); status(connectionStatus);
    if (!fromPopstate) syncUrl({ view: id, hash, mode: 'push' });
    leaveGuard.leave(new URL(doc.sibling + hash, location.href).href); return;
  } catch (error) { if (revision === navigationRevision) { navigationError = error.message; status(connectionStatus); } }
  finally {
    if (revision === navigationRevision) {
      navigationPending = false;
      if (leavesPage && !leaveGuard.isLeaving()) {
        resumeRefresh();
        if (queuedUrlChange) { const next = queuedUrlChange; queuedUrlChange = null; if (!next.view || next.view === selected) synchronizeNavigation(selected).catch(() => {}); handleUrlChange(next); }
        else if (fromPopstate) syncUrl({ view: selected, hash: currentHash, mode: 'push' });
      }
    }
  }
}
function handleUrlChange({ view, hash = '' }) {
  if (leaveGuard.isLeaving()) { queuedUrlChange = { view, hash }; return; }
  lastReplaceUrl = null;
  if (!rendered || navigationPending) { queuedUrlChange = { view, hash }; return; }
  const target = labelFor(view) || documents.some(doc => doc.id === view) ? view : selected;
  syncUrl({ view: target, hash, mode: 'replace' });
  if (target !== selected) select(target, { fromPopstate: true, hash });
  else { currentViewHash = hash; pendingHash = hash; replaceFrameHash(hash); scrollToFragment(hash); }
}
window.addEventListener('lavish:urlChange', event => handleUrlChange(event.detail));
window.addEventListener('popstate', () => { if (window.self === window.top && !globalThis.lavish?.syncUrl) handleUrlChange({ view: new URLSearchParams(location.search).get('view') || '', hash: location.hash }); });
const snapshotContent = value => value && JSON.stringify({ operationId: value.operationId, version: value.version, base: value.base, head: value.head, baseDisplay: value.baseDisplay, headDisplay: value.headDisplay, commits: value.commits, patch: value.patch });
// A rerender replaces the focused editor, so one made only to update a notice carries the
// caret into the replacement field. Returns the generation it rendered, or null when a
// newer render took its place.
async function renderViewKeepingFocus() {
  const active = document.activeElement;
  const label = active?.closest('#view') && active.getAttribute('aria-label');
  const selection = label && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
  const rendering = renderView(); const generation = renderGeneration;
  await rendering;
  if (generation !== renderGeneration) return null;
  if (active && !active.isConnected && label) {
    const replacement = [...document.querySelectorAll('#view [aria-label]')].find(node => node.getAttribute('aria-label') === label);
    if (replacement) { replacement.focus(); if (selection) replacement.setSelectionRange(...selection); }
  }
  return generation;
}
async function refresh(force = false) {
  // A forced snapshot outlives the call that asked for it: the button and a save both
  // mean "the next snapshot must be uncached", and only the request below spends it.
  if (force) { snapshotForce = true; invalidateRange(); }
  // The first refresh runs even in a hidden tab so a page opened in the background has
  // content when it is shown, and only that one: it is spent whether or not it succeeds,
  // because a page that never rendered has no rendered state to tell the warm attempt
  // from a background poll. Later polls wait for visibility instead.
  const warm = tabHidden && !warmed;
  if (refreshPaused || busy || (tabHidden && !warm)) { queueRefresh(); return; }
  warmed = true;
  busy = true;
  // This run honours the owed follow-up; anything asked for while it runs is queued again.
  refreshRequested = false;
  const navigationAtStart = navigationRevision, collapseAtStart = collapseRevision;
  let pauseRevision;
  try {
    const [state, list] = await Promise.all([action('status'), action('documents')]);
    if (refreshPaused) return;
    // The tab went hidden while status and documents were in flight. A snapshot costs
    // several jj runs, so only the warm attempt asked for in the background keeps going;
    // a refresh that is no longer being watched leaves it to the visibility catch-up.
    if (tabHidden && !warm) return;
    const nextTitle = state.title || '';
    if (nextTitle !== sessionTitle) {
      sessionTitle = nextTitle;
      const title = document.querySelector('.hub-session-title');
      title.textContent = sessionTitle;
      title.hidden = !sessionTitle;
      document.querySelector('.hub-repo-name').textContent = identityName();
      updateTabTitle();
    }
    const withoutCollapse = doc => { if (!doc) return null; const { collapsed, ...rest } = doc; return rest; };
    let oldSelected = selected, oldDocuments = JSON.stringify(documents), oldSelectedDoc = JSON.stringify(withoutCollapse(documents.find(item => item.id === selected)));
    const oldSnapshot = snapshot, snapshotWasLoading = snapshotLoading();
    if (collapseAtStart !== collapseRevision) {
      for (const doc of list.documents) { const local = documents.find(item => item.id === doc.id && item.version === doc.version); if (local) doc.collapsed = local.collapsed; }
      queueRefresh();
    }
    documents = list.documents;
    if (!rendered && queuedUrlChange) {
      initialView = queuedUrlChange.view; pendingHash = queuedUrlChange.hash; currentViewHash = queuedUrlChange.hash;
      replaceFrameHash(currentViewHash); queuedUrlChange = null;
    }
    let requestedInitialView = '';
    if (initialView) {
      const candidate = initialView;
      initialView = '';
      if (Object.hasOwn(labels, candidate) || documents.some(doc => doc.id === candidate)) requestedInitialView = candidate;
      else { pendingDeepLinkNotice = `Unknown view "${candidate}".`; pendingDeepLink = null; }
    }
    const targetSelection = requestedInitialView || (pendingDeepLinkNotice ? 'diff' : state.selected);
    if (!rendered && targetSelection) selected = targetSelection;
    noteUpdates(state, documents);
    let selectedDoc = documents.find(item => item.id === selected);
    if (!rendered && pendingDeepLinkNotice && selectedDoc?.sibling) {
      selected = 'diff';
      selectedDoc = null;
    }
    if (!rendered && selectedDoc?.sibling && selectedDoc.source?.toLowerCase().endsWith('.html')) {
      pauseRevision = pauseRefresh();
      if (requestedInitialView && requestedInitialView !== state.selected) await action('navigate', { id: requestedInitialView }).catch(() => {});
      if (queuedUrlChange) { selected = oldSelected; if (pauseRevision === refreshPauseRevision) resumeRefresh(); return; }
      syncUrl({ view: selectedDoc.id, hash: pendingHash || '', mode: 'replace' });
      selected = oldSelected;
      leaveGuard.leave(new URL(selectedDoc.sibling + (pendingHash || ''), location.href).href); return;
    }
    if (!rendered && requestedInitialView && requestedInitialView !== state.selected) synchronizeNavigation(requestedInitialView).catch(() => {});
    // Ask for the snapshot only on the views that render it, and only for the
    // selection the owner settled on above. Issuing the request transfers the queued
    // intent to this generation, so a later entry queues its own and this one settles
    // only its own.
    const requestSnapshot = needsSnapshot(selected);
    const request = requestSnapshot ? ++snapshotRequest : 0;
    // The request itself spends the forced intent, whether or not it succeeds, so a
    // failed snapshot does not force every later poll.
    const forced = snapshotForce;
    if (request) { snapshotQueued = false; snapshotPreflightFailed = false; snapshotForce = false; }
    const snapshotResult = request ? action('snapshot', { force: forced, knownVersion: forced ? undefined : oldSnapshot?.version })
      .then(value => ({ value: value.unchanged === true ? oldSnapshot : value }))
      .catch(error => ({ error })) : null;
    const initialRender = !rendered;
    if (initialRender) {
      syncUrl({ view: selected, hash: pendingHash || '', mode: 'replace' }); renderNav(); oldSelected = selected; oldDocuments = JSON.stringify(documents); await renderView();
      if (queuedUrlChange) { const next = queuedUrlChange; queuedUrlChange = null; handleUrlChange(next); }
    }
    const result = await snapshotResult;
    if (navigationAtStart !== navigationRevision) oldSelected = selected;
    // A snapshot that settles while the page is leaving is still the newest repository
    // state, so keep it with the generation it belongs to and let the resumed page start
    // from it. Both have to move together: advancing the generation alone would clear a
    // save's awaiting-snapshot watermark against content older than the save. Nothing
    // renders, reads, or navigates here, so the view is marked unrendered and the resumed
    // refresh renders the kept snapshot even when its own request returns the same
    // content. A failed snapshot keeps nothing and stays unsettled, so the catch-up
    // retries it.
    if (refreshPaused) {
      if (request && result && !result.error) { snapshot = result.value; snapshotApplied = request; snapshotUnrendered = true; }
      return;
    }
    // A settled request is spent whether or not it succeeded: the view has to drop its
    // loading notice and say the snapshot is unavailable. The pause path above keeps only
    // a successful one, so a failed one stays unsettled and the catch-up asks again.
    if (request) snapshotApplied = request;
    // Clearing the failed snapshot is what makes settling its generation safe: with nothing
    // on screen no render can read the advanced generation against content older than a
    // save and clear that save's awaiting-snapshot watermark.
    if (result?.error) { snapshot = undefined; status(result.error.message); }
    else {
      if (result) snapshot = result.value;
      status(state.available ? 'Connected' : 'Workspace unavailable');
    }
    let documentChanged = false;
    const documentNavigation = navigationRevision;
    const cached = drafts.get(`doc:${selected}`);
    if (cached && cached.text === cached.original && !cached.saving) {
      try {
        const data = await action('readDocument', { id: selected });
        // Do not replace a draft edited while the read was in flight.
        if (cached.text === cached.original && !cached.saving) {
          documentChanged = cached.hash !== data.hash || cached.version !== data.version;
          if (documentChanged) Object.assign(cached, { text: data.text, original: data.text, hash: data.hash, version: data.version, message: '' });
        }
      } catch (error) { if (cached.message !== error.message) { cached.message = error.message; documentChanged = true; } }
    }
    if (refreshPaused || documentNavigation !== navigationRevision) return;
    const doc = documents.find(item => item.id === selected);
    const frame = frames.get(selected);
    let htmlData;
    if (doc?.source?.toLowerCase().endsWith('.html')) {
      try {
        const data = await action('readDocument', { id: selected });
        if (refreshPaused || documentNavigation !== navigationRevision) return;
        htmlData = data;
        if (frame && (frame.version !== data.version || (frame.hash !== undefined && frame.hash !== data.hash))) { frame.version = data.version; frame.hash = data.hash; frame.node.src = frame.url; }
        else if (frame) { frame.version = data.version; frame.hash = data.hash; }
      } catch (error) { status(error.message); }
    }
    if (!rendered || oldSelected !== selected || oldDocuments !== JSON.stringify(documents)) renderNav();
    if (displayedDoc && displayedDoc.id === selected) acknowledgeDisplayed(displayedDoc.id, displayedDoc.version);
    const currentSelectedDoc = JSON.stringify(withoutCollapse(documents.find(item => item.id === selected)));
    // The loading flag is part of the comparison: a snapshot request that fails
    // before any snapshot exists must still replace the loading notice, and one
    // that settles back onto unchanged content must drop the refreshing notice. A
    // snapshot kept across a pause compares equal to its own content, so the flag it
    // left behind is what tells the resumed view to render it.
    if ((forced && request && selected === 'diff') || (initialRender && needsSnapshot(selected)) || !rendered || oldSelected !== selected || oldSelectedDoc !== currentSelectedDoc || documentChanged || (snapshotUnrendered && needsSnapshot(selected)) || (needsSnapshot(selected) && ((oldSnapshot !== snapshot && snapshotContent(oldSnapshot) !== snapshotContent(snapshot)) || snapshotWasLoading !== snapshotLoading()))) {
      const generation = await renderViewKeepingFocus();
      snapshotUnrendered = false;
      if (generation === null || documentNavigation !== navigationRevision) return;
      const createdFrame = frames.get(selected);
      if (!frame && createdFrame && htmlData) { createdFrame.version = htmlData.version; createdFrame.hash = htmlData.hash; }
    }
  } catch (error) {
    status(error.message);
    // The preflight failed before any snapshot request could be issued: the owed request
    // has to stop claiming to load, while it stays queued so the next poll asks again.
    // The notice renders over the draft being typed, so it keeps that editor's focus. A
    // render that fails instead is reported: it leaves the notice the failure was meant to
    // correct, and swallowing it would hide why the view still claims to load.
    if (snapshotQueued && !snapshotPreflightFailed) {
      snapshotPreflightFailed = true;
      if (needsSnapshot(selected)) try { await renderViewKeepingFocus(); } catch (error) { status(error.message); }
    }
    if (refreshPaused && pauseRevision === refreshPauseRevision && !navigationPending && !leaveGuard.isLeaving()) resumeRefresh();
  }
  finally {
    busy = false; clearTimeout(refreshTimer);
    // A hidden tab drops its timer; becoming visible catches up immediately.
    if (refreshPaused || tabHidden) return;
    if (refreshRequested) refresh();
    else refreshTimer = setTimeout(refresh, 2000);
  }
}
function draft(key, initial) { if (!drafts.has(key)) drafts.set(key, initial); return drafts.get(key); }
function editor(label, value, onInput) { const area = el('textarea', null, { 'aria-label': label, rows: '5', spellcheck: 'false' }); area.value = value; area.addEventListener('input', () => onInput(area.value)); return area; }
function notice(text) { return el('p', text, { role: 'status', class: 'notice' }); }
function renderDeepLinkNotice() {
  const view = document.querySelector('#view');
  view.querySelector('.deep-link-notice')?.remove();
  if (pendingDeepLinkNotice) { const node = notice(pendingDeepLinkNotice); node.classList.add('deep-link-notice'); view.prepend(node); }
}
async function navigateDeepLink(target) {
  if (!Object.hasOwn(labels, target.view) && !documents.some(doc => doc.id === target.view)) {
    pendingDeepLinkNotice = `Unknown view "${target.view}".`; renderDeepLinkNotice(); return;
  }
  pendingDeepLinkNotice = '';
  renderDeepLinkNotice();
  pendingDeepLink = target.file || target.change ? target : null;
  if (target.view === 'diff') { manualRange(); range = null; rangeAnchor = null; }
  if (selected === target.view && !snapshotLoading()) await renderViewKeepingFocus();
  else await select(target.view, { deepLink: true });
}
const storage = createSafeStorage();
const reviewWorkspace = el('div', null, { class: 'review-workspace' });
const rail = el('aside', null, { class: 'commit-rail', 'aria-label': 'Commit selection' });
const railHead = el('div', null, { class: 'commit-rail-head' });
const railTitle = el('strong');
const railAll = button('All', () => { manualRange(); range = null; rangeAnchor = null; updateReview(); });
const railToggle = button('', () => railPane.setCollapsed(!railPane.getState().collapsed));
railToggle.className = 'rail-toggle';
const railScroll = el('div', null, { class: 'commit-rail-scroll', role: 'region', 'aria-label': 'Commits', tabindex: '0' });
const railResizer = el('div', null, { class: 'rail-resizer', 'aria-hidden': 'true' });
const reviewRight = el('div', null, { class: 'review-right' });
const drawer = el('div', null, { class: 'commit-editor-drawer', hidden: '' });
const rangeBar = el('div', null, { class: 'review-range-bar' });
const rangeText = el('span', '', { class: 'review-range-text' });
const rangeStatus = el('span', '', { class: 'review-range-status', role: 'status' });
railHead.append(railTitle, railAll); rail.append(railToggle, railHead, railScroll);
rangeBar.append(rangeText, rangeStatus); reviewRight.append(drawer, rangeBar, diffContainer);
reviewWorkspace.append(rail, railResizer, reviewRight);
let range = null, rangeAnchor = null, editingChange = null, savedRangeBeforeEdit = null;
let rangeRequestId = 0, requestedRange = '', rangeError = '';
const rows = new Map(), openBodies = new Set();
const railPane = attachResizablePane({ storage, widthKey: 'lavish-hub-rail-width', collapsedKey: 'lavish-hub-rail-collapsed', defaultWidth: 280, minWidth: 190, maxWidth: 460, onChange: updateRailPane });
function updateRailPane({ width, collapsed }) {
  reviewWorkspace.style.setProperty('--rail-width', `${collapsed ? 38 : width}px`);
  rail.classList.toggle('is-collapsed', collapsed);
  railHead.hidden = railScroll.hidden = collapsed;
  railToggle.textContent = collapsed ? '»' : '«';
  railToggle.setAttribute('aria-expanded', String(!collapsed));
  railToggle.setAttribute('aria-label', collapsed ? 'Expand commits' : 'Collapse commits');
  railToggle.title = railToggle.getAttribute('aria-label');
}
updateRailPane(railPane.getState());
railPane.attachResizer(railResizer, event => event.clientX - rail.getBoundingClientRect().left);
function invalidateRange() { rangeRequestId++; requestedRange = ''; rangeError = ''; }
function manualRange() { if (editingChange) savedRangeBeforeEdit = null; invalidateRange(); }
function selectCommit(changeId, shift) {
  manualRange();
  if (shift && rangeAnchor && snapshot.commits.some(commit => commit.changeId === rangeAnchor)) range = { start: rangeAnchor, end: changeId };
  else if (range?.start === changeId && range.end === changeId) { range = null; rangeAnchor = null; }
  else { rangeAnchor = changeId; range = { start: changeId, end: changeId }; }
  updateReview();
}
function selectedIndices() {
  if (!range) return null;
  const start = snapshot.commits.findIndex(commit => commit.changeId === range.start);
  const end = snapshot.commits.findIndex(commit => commit.changeId === range.end);
  if (start < 0 || end < 0) { range = null; rangeAnchor = null; invalidateRange(); return null; }
  return [Math.min(start, end), Math.max(start, end)];
}
function commitDraft(commit) {
  const state = draft(`commit:${commit.changeId}`, { text: commit.description, original: commit.description, commitId: commit.commitId, message: '' });
  if (state.awaitingSnapshot && (commit.commitId === state.awaitingSnapshot.commitId || snapshotApplied > state.awaitingSnapshot.after)) state.awaitingSnapshot = null;
  if (state.text === state.original && !state.saving && !state.message && !state.awaitingSnapshot) Object.assign(state, { text: commit.description, original: commit.description, commitId: commit.commitId });
  return state;
}
function closeCommitEditor() {
  const closedChange = editingChange;
  editingChange = null; drawer.hidden = true; drawer.replaceChildren();
  if (savedRangeBeforeEdit) { range = savedRangeBeforeEdit.range; rangeAnchor = savedRangeBeforeEdit.anchor; }
  savedRangeBeforeEdit = null; invalidateRange(); updateReview();
  const row = rows.get(closedChange), edit = row?.querySelector('.commit-edit');
  (edit && !edit.hidden && !edit.disabled ? edit : row?.querySelector('.rail-pick'))?.focus({ preventScroll: true });
}
function openCommitEditor(changeId) {
  const commit = snapshot.commits.find(item => item.changeId === changeId);
  if (!commit || commit.immutable || commit.divergent) return;
  if (editingChange && drafts.get(`commit:${editingChange}`)?.saving) return;
  if (!editingChange) savedRangeBeforeEdit = { range: range && { ...range }, anchor: rangeAnchor };
  editingChange = changeId; range = { start: changeId, end: changeId }; rangeAnchor = changeId;
  commitDraft(commit); invalidateRange(); renderDrawer(true); updateReview();
}
function renderDrawer(focus = false) {
  const commit = snapshot.commits.find(item => item.changeId === editingChange);
  if (!commit) {
    if (!drafts.get(`commit:${editingChange}`)?.saving) { editingChange = null; savedRangeBeforeEdit = null; drawer.hidden = true; drawer.replaceChildren(); }
    return;
  }
  const existing = drafts.get(`commit:${commit.changeId}`), oldText = existing?.text;
  const state = commitDraft(commit);
  let area = drawer.querySelector('textarea');
  if (area && drawer.dataset.changeId === editingChange && area.value === oldText && oldText !== state.text) area.value = state.text;
  if (!area || drawer.dataset.changeId !== editingChange) {
    drawer.replaceChildren(); drawer.dataset.changeId = editingChange;
    const heading = el('div', null, { class: 'commit-editor-heading' });
    heading.append(el('span', '', { class: 'commit-editor-ids' }), el('strong', 'Edit commit description'));
    area = editor(`Description ${commit.changeId.slice(0, 12)}`, state.text, value => { state.text = value; });
    area.className = 'commit-editor'; area.rows = 1; area.wrap = 'off';
    const save = button('Save description', async () => {
      if (state.saving) return;
      const submitted = state.text; state.saving = true; renderDrawer(); updateRows();
      try {
        const result = await action('describe', { changeId: commit.changeId, commitId: state.commitId, expectedDescription: state.original, description: submitted });
        if (result.status !== 'saved') state.message = `Conflict: ${result.reason}. Current description: ${result.current?.map(row => row.description).join(' / ') || '(unavailable)'}`;
        else {
          state.awaitingSnapshot = { after: snapshotRequest, commitId: result.current.commitId };
          state.original = result.current.description; state.commitId = result.current.commitId; state.message = '';
          if (state.text === submitted) { state.text = state.original; state.saving = false; closeCommitEditor(); refresh(true); return; }
          refresh(true);
        }
      } catch (error) { state.message = error.message; }
      state.saving = false; if (selected === 'diff') { renderDrawer(); updateRows(); }
    });
    save.className = 'commit-save';
    const cancel = button('Cancel', () => { if (state.saving) return; state.text = state.original; state.message = ''; closeCommitEditor(); });
    cancel.className = 'commit-cancel';
    area.addEventListener('keydown', event => { if (event.key === 'Escape' && !state.saving) { event.preventDefault(); cancel.click(); } });
    const controls = el('div', null, { class: 'commit-controls' }); controls.append(save, cancel);
    drawer.append(heading, area, controls, el('p', '', { class: 'save-error', role: 'alert' }));
  }
  drawer.hidden = false;
  drawer.querySelector('.commit-editor-ids').textContent = `${commit.changeId.slice(0, 12)} · ${commit.commitId.slice(0, 12)}`;
  drawer.querySelector('.commit-save').disabled = !!state.saving || commit.immutable || commit.divergent;
  drawer.querySelector('.commit-cancel').disabled = !!state.saving;
  drawer.querySelector('.save-error').textContent = state.message || '';
  if (focus) area.focus({ preventScroll: true });
}
function createRailRow(changeId) {
  const row = el('div', null, { class: 'rail-row', 'data-change-id': changeId });
  const graph = el('div', null, { class: 'rail-graph', 'aria-hidden': 'true' });
  graph.append(el('span', null, { class: 'rail-node' }), el('span', null, { class: 'rail-line' }));
  const pick = button('', event => selectCommit(changeId, event.shiftKey)); pick.className = 'rail-pick';
  pick.append(el('span', '', { class: 'rail-subj' }), el('span', '', { class: 'rail-sub' }));
  const peek = button('⌄', () => { if (openBodies.has(changeId)) openBodies.delete(changeId); else openBodies.add(changeId); updateRows(); });
  peek.className = 'body-peek-btn'; peek.setAttribute('aria-label', `Toggle description ${changeId.slice(0, 12)}`);
  const edit = editButton(`Description ${changeId.slice(0, 12)}`, () => openCommitEditor(changeId));
  const preview = el('div', '', { class: 'rail-body-preview' });
  row.append(graph, pick, peek, edit, preview);
  row.addEventListener('click', event => { if (!event.target.closest('button, .rail-body-preview')) selectCommit(changeId, event.shiftKey); });
  return row;
}
function updateRows() {
  const commits = snapshot.commits, indices = selectedIndices();
  railTitle.textContent = `Commits (${indices ? indices[1] - indices[0] + 1 : commits.length}/${commits.length})`;
  const present = new Set(commits.map(commit => commit.changeId));
  for (const [id, row] of rows) if (!present.has(id)) { row.remove(); rows.delete(id); openBodies.delete(id); }
  let empty = railScroll.querySelector('.rail-empty');
  if (!commits.length) { if (!empty) { empty = el('p', 'No commits in this range.', { class: 'rail-empty' }); railScroll.append(empty); } }
  else empty?.remove();
  commits.forEach((commit, index) => {
    let row = rows.get(commit.changeId);
    if (!row) { row = createRailRow(commit.changeId); rows.set(commit.changeId, row); }
    const at = railScroll.children[index]; if (at !== row) railScroll.insertBefore(row, at || null);
    const state = drafts.get(`commit:${commit.changeId}`);
    const pendingSave = state?.awaitingSnapshot && commit.commitId !== state.awaitingSnapshot.commitId && snapshotApplied <= state.awaitingSnapshot.after;
    const description = (pendingSave ? state.original : commit.description) || '', [subject, ...bodyLines] = description.split('\n'), body = bodyLines.join('\n').trim();
    const subjectNode = row.querySelector('.rail-subj'); subjectNode.textContent = subject || '(no description set)';
    if (body || subject.length > 50) subjectNode.title = description; else subjectNode.removeAttribute('title');
    row.querySelector('.rail-sub').textContent = `${commit.changeId.slice(0, 12)}${commit.isWorkingCopy ? ' · @' : ''}`;
    row.classList.toggle('is-selected', !indices || (index >= indices[0] && index <= indices[1]));
    row.querySelector('.rail-line').hidden = index === commits.length - 1;
    const peek = row.querySelector('.body-peek-btn'); peek.hidden = !body; peek.setAttribute('aria-expanded', String(openBodies.has(commit.changeId)));
    const preview = row.querySelector('.rail-body-preview'); preview.hidden = !body || !openBodies.has(commit.changeId); preview.textContent = body;
    const edit = row.querySelector('.commit-edit'); edit.hidden = commit.immutable || commit.divergent; edit.disabled = !!drafts.get(`commit:${editingChange}`)?.saving || !!drafts.get(`commit:${commit.changeId}`)?.saving; edit.classList.toggle('is-editing', editingChange === commit.changeId);
  });
}
function updateReview() {
  if (!snapshot || selected !== 'diff' || !diffView) return;
  updateRows(); if (editingChange) renderDrawer();
  const indices = selectedIndices(), commits = snapshot.commits;
  const baseDisplay = snapshot.baseDisplay || snapshot.base.slice(0, 12), headDisplay = snapshot.headDisplay || snapshot.head.slice(0, 12);
  let label, request;
  if (!indices) label = `--from ${baseDisplay} --to ${headDisplay}`;
  else if (indices[0] === indices[1]) { const commit = commits[indices[0]]; label = `-r ${commit.changeId.slice(0, 12)}`; request = { rev: commit.commitId }; }
  else {
    const top = commits[indices[0]], previous = commits[indices[1] + 1];
    label = `--from ${previous ? previous.changeId.slice(0, 12) : baseDisplay} --to ${top.changeId.slice(0, 12)}`;
    request = { from: previous?.commitId || snapshot.base, to: top.commitId };
  }
  rangeText.textContent = label;
  const revision = request?.rev || request?.to || snapshot.head;
  const pinnedRange = request?.rev || (request ? `${request.from} → ${request.to}` : `${snapshot.base} → ${snapshot.head}`);
  const data = { root: config.workspace, range: pinnedRange, rangeSource: 'workspace snapshot', revision, operationId: snapshot.operationId, snapshotVersion: snapshot.version, kind: 'jj', to: revision };
  if (!request) {
    if (requestedRange) invalidateRange();
    rangeStatus.textContent = snapshotLoading() ? 'Refreshing repository snapshot…' : '';
    diffView.update({ ...data, patch: snapshot.patch, rangeKey: null });
  } else {
    const key = JSON.stringify([snapshot.operationId, request]);
    if (requestedRange !== key) {
      requestedRange = key; rangeError = ''; const requestId = ++rangeRequestId;
      rangeStatus.textContent = 'Loading diff…';
      action('diffRange', { operationId: snapshot.operationId, ...request }).then(result => {
        if (requestId !== rangeRequestId || selected !== 'diff') return;
        rangeStatus.textContent = ''; diffView.update({ ...data, patch: result.patch, snapshotVersion: result.version, rangeKey: result.rangeKey });
      }).catch(error => { if (requestId === rangeRequestId && selected === 'diff') { rangeError = error.message; rangeStatus.textContent = rangeError; } });
    } else if (rangeError) rangeStatus.textContent = rangeError;
  }
  if (!snapshotLoading() && pendingDeepLink?.view === 'diff') {
    const target = pendingDeepLink; pendingDeepLink = null;
    if (target.file) diffView.revealTarget(target);
    if (target.change) {
      const key = target.change.toLowerCase(), exact = commits.filter(commit => commit.changeId.toLowerCase() === key);
      const matches = exact.length ? exact : commits.filter(commit => commit.changeId.toLowerCase().startsWith(key));
      if (matches.length === 1) {
        railPane.setCollapsed(false); const row = rows.get(matches[0].changeId);
        if (row) { if (railScroll.scrollHeight <= railScroll.clientHeight) row.scrollIntoView({ block: 'nearest' }); else railScroll.scrollTop = Math.max(0, row.offsetTop - railScroll.offsetTop - (railScroll.clientHeight - row.offsetHeight) / 2); row.classList.add('deep-link-highlight'); setTimeout(() => row.classList.remove('deep-link-highlight'), 2500); }
      } else { pendingDeepLinkNotice = matches.length ? `Change prefix "${target.change}" is ambiguous (matches ${matches.map(commit => commit.changeId.slice(0, 12)).join(', ')}).` : `Commit "${target.change}" is not in the current snapshot.`; renderDeepLinkNotice(); }
    }
  }
}
let renderGeneration = 0;
async function renderView() {
  const rendering = renderViewContent(); const generation = renderGeneration;
  await rendering;
  if (generation === renderGeneration && pendingHash !== null) scrollToFragment(pendingHash);
}
async function renderViewContent() {
  const generation = ++renderGeneration;
  displayedDoc = null;
  const view = document.querySelector('#view');
  const id = selected;
  if (id === 'diff' && snapshot && reviewWorkspace.isConnected && diffView) {
    rendered = true; renderDeepLinkNotice(); updateReview(); return;
  }
  if (id !== 'diff' || !snapshot) { diffView?.hide(); invalidateRange(); }
  view.replaceChildren(); rendered = true;
  renderDeepLinkNotice();
  updateTabTitle();
  if (modeView !== id) {
    if (startsInExplore(id) || startsInExplore(modeView)) globalThis.lavish?.setAnnotationMode?.(!startsInExplore(id));
    modeView = id;
  }
  view.classList.toggle('diff-view', id === 'diff');
  app.classList.toggle('is-diff-view', id === 'diff');
  for (const [key, frame] of frames) frame.node.hidden = key !== id || !documents.find(doc => doc.id === key)?.source?.toLowerCase().endsWith('.html');
  if (id === 'diff') {
    if (!snapshot) { view.append(notice(snapshotLoading() ? 'Loading repository snapshot…' : 'Repository snapshot unavailable. Refresh after checking the workspace and jj configuration.')); return; }
    if (!(await requireBundle('diff', 'mountLavishDiff', view, generation))) return;
    view.append(reviewWorkspace);
    if (!diffView) diffView = globalThis.mountLavishDiff(diffContainer, { embedded: true, hideSidebar: true, collapsedByDefault: true, loadDiffFiles: (operationId, fileIndex, version, rangeKey) => action('diffFiles', { operationId, fileIndex, version, rangeKey }) });
    updateReview();
    return;
  }
  view.append(el('h1', labelFor(id) || documents.find(doc => doc.id === id)?.title || id));
  const doc = documents.find(item => item.id === id);
  if (doc?.metadata && Object.keys(doc.metadata).length) { const scope = el('p', Object.entries(doc.metadata).map(([key, value]) => `${key}: ${value}`).join(' · '), { class: 'muted' }); view.append(scope); }
  if (doc?.source?.toLowerCase().endsWith('.html')) {
    const file = doc.source.split('/').pop();
    const url = `${config.url}/resources/${config.resourceKey}/${encodeURIComponent(id)}/${encodeURIComponent(file)}`;
    let frame = frames.get(id);
    if (!frame) {
      const node = el('iframe', null, { title: doc.title, sandbox: 'allow-scripts allow-forms allow-popups allow-downloads', referrerpolicy: 'no-referrer', src: url });
      node.className = 'published-document'; document.querySelector('#frames').append(node);
      frame = { node, url, version: doc.version, hash: undefined, loaded: false }; frames.set(id, frame);
      node.addEventListener('load', () => {
        frame.loaded = true;
        if (selected === id) { displayedDoc = { id, version: frame.version }; acknowledgeDisplayed(id, frame.version); }
      });
    } else {
      frame.node.title = doc.title;
      if (frame.url !== url) { frame.url = url; frame.loaded = false; frame.node.src = url; frame.version = doc.version; frame.hash = undefined; }
      frame.node.hidden = false;
      if (frame.loaded) { displayedDoc = { id, version: frame.version }; acknowledgeDisplayed(id, frame.version); }
    }
    return;
  }
  const bundle = (doc || id === 'tasks') ? loadBundle('markdown', 'hubMarkdownRenderer').then(() => null, error => error) : null;
  let state = drafts.get(`doc:${id}`);
  if (!state) {
    try { const data = await action('readDocument', { id }); if (generation !== renderGeneration) return; state = draft(`doc:${id}`, { text: data.text, original: data.text, hash: data.hash, version: data.version, preview: true }); }
    catch (error) { if (generation === renderGeneration) view.append(notice(error.message)); return; }
  }
  if (generation !== renderGeneration) return;
  if (bundle) {
    const error = await bundle;
    if (generation !== renderGeneration) return;
    if (error) { view.append(notice(error.message), button('Retry', () => renderView())); return; }
  }
  const info = notice(state.message || '');
  const area = editor(id === 'tasks' ? 'Tasks Markdown' : 'Document Markdown', state.text, value => { state.text = value; info.textContent = value === state.original ? '' : 'Unsaved changes'; });
  if (id === 'tasks') {
    const resize = () => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`; };
    area.addEventListener('input', resize);
    area.className = 'tasks-editor';
    requestAnimationFrame(resize);
  }
  const save = button('Save', async () => {
    if (state.saving) return;
    const submitted = state.text; state.saving = true; save.disabled = true; cancel.disabled = true; info.textContent = 'Saving…';
    for (const checkbox of view.querySelectorAll('input[data-task-line]')) checkbox.disabled = true;
    try {
      const result = await action('saveDocument', { id, version: state.version, baseHash: state.hash, text: submitted });
      state.message = result.reply === 'Saved' ? '' : result.reply;
      if (result.reply === 'Saved') { const data = await action('readDocument', { id }); if (data.version === state.version && data.text === submitted) { state.hash = data.hash; state.original = submitted; if (state.text === submitted) state.editing = false; } else { state.message = 'Saved, but the source changed afterwards. Your draft is retained.'; state.editing = true; } }
      else state.editing = true;
    } catch (error) { state.message = error.message; state.editing = true; }
    state.saving = false;
    if (selected === id) renderView();
  });
  save.className = 'commit-save'; save.disabled = !!state.saving;
  const cancel = button('Cancel', () => { if (state.saving) return; state.text = state.original; state.message = ''; state.editing = false; renderView(); });
  cancel.className = 'commit-cancel'; cancel.disabled = !!state.saving;
  area.addEventListener('keydown', event => { if (event.key === 'Escape' && !state.saving) { event.preventDefault(); cancel.click(); } });
  if (doc || id === 'tasks') {
    const preview = el('div', null, { class: 'hub-markdown', 'aria-label': 'Rendered Markdown' });
    const base = doc ? `${config.url}/resources/${config.resourceKey}/${encodeURIComponent(id)}/${encodeURIComponent(doc.source.split('/').pop())}` : location.href;
    const render = globalThis.hubMarkdownRenderer(area, preview, {
      hideFrontMatter: true,
      onTaskToggle: id === 'tasks' ? (line, checked) => {
        const lines = state.text.split('\n');
        lines[line] = lines[line].replace(/^((?:\s*>)*\s*(?:(?:[-*+]|\d+[.)])\s+)\[)[ xX](\])/, `$1${checked ? 'x' : ' '}$2`);
        state.text = lines.join('\n'); area.value = state.text; save.click();
      } : undefined,
      afterRender: root => {
        if (state.saving) for (const checkbox of root.querySelectorAll('input[data-task-line]')) checkbox.disabled = true;
        for (const node of root.querySelectorAll('[src], [href]')) for (const attr of ['src', 'href']) {
          const value = node.getAttribute(attr);
          if (attr === 'href' && node.tagName === 'A' && parseHubDeepLink(value)) { node.setAttribute('data-lavish-action', ''); continue; }
          if (value && !value.startsWith('#') && !value.startsWith('/') && !/^[a-z][a-z\d+.-]*:/i.test(value)) node.setAttribute(attr, new URL(value, base).href);
        }
        if (generation === renderGeneration && selected === id && pendingHash !== null) scrollToFragment(pendingHash);
        if (doc && generation === renderGeneration && selected === id) {
          displayedDoc = { id, version: state.version };
          acknowledgeDisplayed(id, state.version);
        }
      },
      onError: error => { info.textContent = `Syntax highlighting unavailable: ${error.message}`; },
    });
    const edit = editButton(id === 'tasks' ? 'Tasks Markdown' : 'Document Markdown', () => { state.editing = true; toggle(); area.focus(); });
    edit.disabled = !!state.saving;
    const wrap = el('div', null, { class: 'commit-description-wrap' }); wrap.append(preview, edit);
    const controls = el('div', null, { class: 'commit-controls' }); controls.append(save, cancel);
    const toggle = () => {
      area.hidden = !state.editing; wrap.hidden = !!state.editing; controls.hidden = !state.editing;
      if (state.editing && id === 'tasks') { area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`; }
      if (state.editing) { if (doc && generation === renderGeneration && selected === id) { displayedDoc = { id, version: state.version }; acknowledgeDisplayed(id, state.version); } }
      else render();
    };
    view.append(wrap, area, controls); toggle();
  } else view.append(area, save);
  view.append(info);
}
app.innerHTML = '<header><div><strong>Workspace hub</strong><div id="workspace"></div></div><div><span id="connection" role="status">Connecting…</span> <button id="refresh" type="button">Refresh</button></div></header><div class="layout"><span id="hub-nav-desc-new" hidden>New publication</span><div class="hub-sidebar"><button type="button" class="hub-sidebar-toggle"></button><div class="hub-identity"><div class="hub-session-title"></div><div class="hub-repo-name"></div></div><nav id="navigation" aria-label="Workspace views"></nav></div><div class="pane-resizer" aria-hidden="true"></div><div class="hub-content"><main id="view"></main><div id="frames"></div></div></div>';
const sidebar = document.querySelector('.hub-sidebar'), sidebarToggle = document.querySelector('.hub-sidebar-toggle');
function updateSidebar({ width, collapsed }) {
  document.querySelector('#app > .layout').style.setProperty('--hub-sidebar-width', `${collapsed ? 38 : width}px`);
  sidebar.classList.toggle('is-collapsed', collapsed);
  sidebar.querySelector('.hub-identity').hidden = sidebar.querySelector('#navigation').hidden = collapsed;
  sidebarToggle.textContent = collapsed ? '»' : '«';
  sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
  sidebarToggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  sidebarToggle.title = sidebarToggle.getAttribute('aria-label');
}
const sidebarPane = attachResizablePane({ storage, widthKey: 'lavish-hub-sidebar-width', collapsedKey: 'lavish-hub-sidebar-collapsed', defaultWidth: 208, minWidth: 160, maxWidth: 420, onChange: updateSidebar });
updateSidebar(sidebarPane.getState());
sidebarToggle.addEventListener('click', () => sidebarPane.setCollapsed(!sidebarPane.getState().collapsed));
sidebarPane.attachResizer(document.querySelector('.pane-resizer'), event => event.clientX - sidebar.getBoundingClientRect().left);
document.querySelector('#view').addEventListener('click', event => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest?.('a[href]');
  if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
  const target = parseHubDeepLink(link.getAttribute('href'));
  if (!target) return;
  event.preventDefault(); navigateDeepLink(target);
});
document.querySelector('#workspace').textContent = config.workspace;
const titleElement = document.querySelector('.hub-session-title');
titleElement.textContent = sessionTitle;
titleElement.hidden = !sessionTitle;
document.querySelector('.hub-repo-name').textContent = identityName();
document.querySelector('#refresh').addEventListener('click', () => refresh(true));
refresh();
