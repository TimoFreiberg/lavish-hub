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
let selected = 'commits', snapshot, documents = [], busy = false;
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
const startsInExplore = id => id === 'commits' || id === 'changes';
// Only the repository views render a snapshot, and a snapshot costs several jj
// runs per request, so only those views ask for one. Status and documents keep
// polling on every view.
const needsSnapshot = startsInExplore;
window.addEventListener('lavish:ready', () => { if (startsInExplore(modeView)) globalThis.lavish?.setAnnotationMode?.(false); updateTabTitle(); if (lastReplaceUrl) syncUrl(lastReplaceUrl); });
const labels = { commits: 'Commits', changes: 'Changes', tasks: 'Tasks' };
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
const { formatTabTitle, applyNavBadge, createLeaveGuard } = globalThis.lavishHubLifecycle;
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
  try { response = await fetch(`${config.url}/action`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lavish-capability': config.capability }, body: JSON.stringify({ ...body, operation }), ...(['status', 'documents', 'snapshot', 'readDocument', 'diffFiles', 'navigate', 'acknowledge'].includes(operation) ? { signal: AbortSignal.timeout(10000) } : {}) }); }
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
function renderNav() {
  const nav = document.querySelector('#navigation');
  const focused = nav.contains(document.activeElement) ? document.activeElement : null;
  const existing = new Map([...nav.querySelectorAll('button[data-hub-id]')].map(b => [b.dataset.hubId, b]));
  const items = [
    ...Object.entries(labels).map(([id, label]) => ({ id, label, unseen: false })),
    ...documents.map(doc => ({ id: doc.id, label: doc.title, unseen: doc.viewedVersion !== doc.version })),
  ];
  let next = nav.firstElementChild;
  for (const item of items) {
    let b = existing.get(item.id);
    if (!b) {
      b = button('', () => select(item.id));
      b.dataset.hubId = item.id;
    } else existing.delete(item.id);
    let label = b.querySelector('.nav-label');
    if (!label) { label = el('span', item.label, { class: 'nav-label' }); b.replaceChildren(label); }
    else if (label.textContent !== item.label) label.textContent = item.label;
    applyNavBadge(b, item.unseen ? 'new' : '', 'hub-nav-desc');
    if (item.id === selected) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
    if (b !== next) nav.insertBefore(b, next);
    next = b.nextElementSibling;
  }
  for (const b of existing.values()) b.remove();
  if (focused?.isConnected && document.activeElement !== focused) focused.focus();
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
const snapshotContent = value => value && JSON.stringify({ base: value.base, head: value.head, commits: value.commits, patch: value.patch });
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
  if (label) {
    const replacement = [...document.querySelectorAll('#view [aria-label]')].find(node => node.getAttribute('aria-label') === label);
    if (replacement) { replacement.focus(); if (selection) replacement.setSelectionRange(...selection); }
  }
  return generation;
}
async function refresh(force = false) {
  // A forced snapshot outlives the call that asked for it: the button and a save both
  // mean "the next snapshot must be uncached", and only the request below spends it.
  if (force) snapshotForce = true;
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
  const navigationAtStart = navigationRevision;
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
    let oldSelected = selected, oldDocuments = JSON.stringify(documents), oldSelectedDoc = JSON.stringify(documents.find(item => item.id === selected) || null);
    const oldSnapshot = snapshot, snapshotWasLoading = snapshotLoading();
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
    const targetSelection = requestedInitialView || state.selected;
    if (!rendered && targetSelection) selected = targetSelection;
    noteUpdates(state, documents);
    let selectedDoc = documents.find(item => item.id === selected);
    if (!rendered && pendingDeepLinkNotice && selectedDoc?.sibling) {
      selected = 'commits';
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
    const currentSelectedDoc = JSON.stringify(documents.find(item => item.id === selected) || null);
    // The loading flag is part of the comparison: a snapshot request that fails
    // before any snapshot exists must still replace the loading notice, and one
    // that settles back onto unchanged content must drop the refreshing notice. A
    // snapshot kept across a pause compares equal to its own content, so the flag it
    // left behind is what tells the resumed view to render it.
    if ((initialRender && needsSnapshot(selected)) || !rendered || oldSelected !== selected || oldSelectedDoc !== currentSelectedDoc || documentChanged || (snapshotUnrendered && needsSnapshot(selected)) || (needsSnapshot(selected) && ((oldSnapshot !== snapshot && snapshotContent(oldSnapshot) !== snapshotContent(snapshot)) || snapshotWasLoading !== snapshotLoading()))) {
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
  pendingDeepLink = target.file || target.change ? target : null;
  if (selected === target.view && !snapshotLoading()) await renderViewKeepingFocus();
  else await select(target.view, { deepLink: true });
}
let renderGeneration = 0;
async function renderView(focusChangeId) {
  const rendering = renderViewContent(focusChangeId); const generation = renderGeneration;
  await rendering;
  if (generation === renderGeneration && pendingHash !== null) scrollToFragment(pendingHash);
}
async function renderViewContent(focusChangeId) {
  const generation = ++renderGeneration;
  displayedDoc = null;
  const view = document.querySelector('#view'); diffView?.hide(); view.replaceChildren(); rendered = true;
  renderDeepLinkNotice();
  const id = selected;
  updateTabTitle();
  if (modeView !== id) {
    if (startsInExplore(id) || startsInExplore(modeView)) globalThis.lavish?.setAnnotationMode?.(!startsInExplore(id));
    modeView = id;
  }
  view.classList.toggle('changes-view', id === 'changes');
  app.classList.toggle('is-changes-view', id === 'changes');
  for (const [key, frame] of frames) frame.node.hidden = key !== id || !documents.find(doc => doc.id === key)?.source?.toLowerCase().endsWith('.html');
  if (id === 'changes') {
    const bar = el('div', null, { class: 'changes-bar' });
    bar.append(el('h1', labels[id]));
    if (!snapshot) { view.append(bar, notice(snapshotLoading() ? 'Loading repository snapshot…' : 'Repository snapshot unavailable. Refresh after checking the workspace and jj configuration.')); return; }
    bar.append(el('span', `--from ${snapshot.base.slice(0, 12)} --to ${snapshot.head.slice(0, 12)}`, { class: 'muted changes-range' }));
    if (snapshotLoading()) bar.append(el('span', 'Refreshing repository snapshot…', { class: 'muted' }));
    view.append(bar);
    if (!(await requireBundle('diff', 'mountLavishDiff', view, generation))) return;
    view.append(diffContainer);
    if (!diffView) diffView = globalThis.mountLavishDiff(diffContainer, { embedded: true, loadDiffFiles: (operationId, fileIndex, version) => action('diffFiles', { operationId, fileIndex, version }) });
    diffView.update({ root: config.workspace, patch: snapshot.patch, range: `${snapshot.base} → ${snapshot.head}`, rangeSource: 'workspace snapshot', revision: snapshot.head, operationId: snapshot.operationId, snapshotVersion: snapshot.version, kind: 'jj', to: snapshot.head });
    if (!snapshotLoading() && pendingDeepLink?.view === 'changes' && pendingDeepLink.file) {
      const target = pendingDeepLink; pendingDeepLink = null; diffView.revealTarget(target);
    }
    return;
  }
  view.append(el('h1', labelFor(id) || documents.find(doc => doc.id === id)?.title || id));
  if (id === 'commits') {
    if (!snapshot) { view.append(notice(snapshotLoading() ? 'Loading repository snapshot…' : 'Repository snapshot unavailable. Refresh after checking the workspace and jj configuration.')); return; }
    view.append(el('p', `--from ${snapshot.base.slice(0, 12)} --to ${snapshot.head.slice(0, 12)}`, { class: 'muted' }));
    // Re-entering a repository view keeps the previous snapshot on screen while the
    // fresh one arrives, so say which of the two the owner is looking at.
    if (snapshotLoading()) view.append(el('p', 'Refreshing repository snapshot…', { class: 'muted' }));
    if (!snapshot.commits.length) view.append(el('p', 'No commits in this range.'));
    for (const commit of snapshot.commits) {
      const key = `commit:${commit.changeId}`, state = draft(key, { text: commit.description, original: commit.description, commitId: commit.commitId, message: '', editing: false });
      if (state.awaitingSnapshot && (commit.commitId === state.awaitingSnapshot.commitId || snapshotApplied > state.awaitingSnapshot.after)) state.awaitingSnapshot = null;
      if (state.text === state.original && !state.saving && !state.message && !state.awaitingSnapshot) { state.text = commit.description; state.original = commit.description; state.commitId = commit.commitId; }
      const card = el('section', null, { class: 'card', 'data-change-id': commit.changeId }); card.append(el('h2', `${commit.changeId.slice(0, 12)} · ${commit.commitId.slice(0, 12)}`));
      const label = `Description ${commit.changeId.slice(0, 12)}`;
      const display = el('div', state.text || '(no description set)', { class: `commit-description${state.text ? '' : ' empty'}`, tabindex: '0', role: 'region', 'aria-label': `Read ${label}` });
      const area = editor(label, state.text, value => { state.text = value; });
      area.className = 'commit-editor'; area.rows = 1; area.wrap = 'off';
      display.hidden = state.editing; area.hidden = !state.editing;
      const edit = editButton(label, () => { state.editing = true; renderView(commit.changeId); });
      edit.hidden = state.editing || commit.immutable || commit.divergent;
      const info = el('p', state.message, { role: 'alert', class: 'save-error' });
      const save = button('Save description', async () => {
        const submitted = state.text; state.saving = true; save.disabled = true; cancel.disabled = true;
        try {
          const result = await action('describe', { changeId: commit.changeId, commitId: state.commitId, expectedDescription: state.original, description: submitted });
          if (result.status !== 'saved') { state.message = `Conflict: ${result.reason}. Current description: ${result.current?.map(row => row.description).join(' / ') || '(unavailable)'}`; }
          else { state.awaitingSnapshot = { after: snapshotRequest, commitId: result.current.commitId }; state.original = result.current.description; state.commitId = result.current.commitId; if (state.text === submitted) { state.text = state.original; state.editing = false; } state.message = ''; refresh(true); }
        } catch (error) { state.message = error.message; }
        state.saving = false;
        if (selected === 'commits') renderView();
      });
      save.disabled = state.saving || commit.immutable || commit.divergent;
      save.className = 'commit-save';
      if (state.message) { save.classList.add('save-failed'); save.title = state.message; save.prepend(el('span', '⚠ ', { 'aria-hidden': 'true' })); }
      if (commit.immutable || commit.divergent) save.title = commit.immutable ? 'Immutable commit' : 'Divergent change';
      const stats = el('pre', null, { class: 'commit-stat', 'aria-label': `Changes ${commit.changeId.slice(0, 12)}` });
      for (const part of (commit.stat || 'No changed files').split(/(\++|-+)/)) stats.append(el('span', part, { class: /^\++$/.test(part) ? 'stat-add' : /^-+$/.test(part) ? 'stat-remove' : '' }));
      const cancel = button('Cancel', () => { if (state.saving) return; state.text = state.original; state.message = ''; state.editing = false; renderView(); });
      cancel.disabled = !!state.saving; cancel.className = 'commit-cancel';
      area.addEventListener('keydown', event => { if (event.key === 'Escape' && !state.saving) { event.preventDefault(); cancel.click(); } });
      save.hidden = cancel.hidden = !state.editing;
      const description = el('div', null, { class: 'commit-description-wrap' }); description.append(display, edit);
      const controls = el('div', null, { class: 'commit-controls' }); controls.append(save, cancel);
      card.append(description, area, controls, info, stats); view.append(card);
      if (state.editing && commit.changeId === focusChangeId) area.focus();
      for (const [node, lines] of [[display, 8], [area, 8], [stats, 6]]) {
        if (!node.hidden) {
          const style = getComputedStyle(node), cap = parseFloat(style.lineHeight) * lines + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
          const height = node.scrollHeight;
          node.style.height = `${Math.min(height, cap)}px`;
          if (node !== area) node.style.resize = height > cap + 1 ? 'vertical' : 'none';
        }
      }
    }
    if (!snapshotLoading() && pendingDeepLink?.view === 'commits' && pendingDeepLink.change) {
      const query = pendingDeepLink.change, key = query.toLowerCase(); pendingDeepLink = null;
      const exact = snapshot.commits.filter(commit => commit.changeId.toLowerCase() === key);
      const matches = exact.length ? exact : snapshot.commits.filter(commit => commit.changeId.toLowerCase().startsWith(key));
      if (matches.length === 1) {
        const card = [...view.querySelectorAll('.card[data-change-id]')].find(node => node.dataset.changeId === matches[0].changeId);
        if (card) {
          card.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
          card.classList.add('deep-link-highlight'); setTimeout(() => card.classList.remove('deep-link-highlight'), 2500);
        }
      } else {
        pendingDeepLinkNotice = matches.length ? `Change prefix "${query}" is ambiguous (matches ${matches.map(commit => commit.changeId.slice(0, 12)).join(', ')}).` : `Commit "${query}" is not in the current snapshot.`;
        renderDeepLinkNotice();
      }
    }
    return;
  }
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
app.innerHTML = '<header><div><strong>Workspace hub</strong><div id="workspace"></div></div><div><span id="connection" role="status">Connecting…</span> <button id="refresh" type="button">Refresh</button></div></header><div class="layout"><span id="hub-nav-desc-new" hidden>New publication</span><div class="hub-sidebar"><div class="hub-identity"><div class="hub-session-title"></div><div class="hub-repo-name"></div></div><nav id="navigation" aria-label="Workspace views"></nav></div><div class="hub-content"><main id="view"></main><div id="frames"></div></div></div>';
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
