const config = globalThis.hubConfig;
if (config.url.startsWith('/')) config.url = new URL(config.url, location.href).href;
const app = document.querySelector('#app');
const drafts = new Map();
const diffContainer = document.createElement('div'); diffContainer.className = 'hub-diff';
let diffView;
const bundleLoads = new Map();
function loadBundle(name, globalName) {
  if (typeof globalThis[globalName] === 'function') return Promise.resolve();
  if (bundleLoads.has(name)) return bundleLoads.get(name);
  const reference = document.querySelector(`audio[data-hub-bundle="${name}"]`);
  const loading = new Promise((resolve, reject) => {
    if (!reference?.src) { reject(new Error(`Missing ${name} renderer`)); return; }
    const script = document.createElement('script');
    script.src = reference.src;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      script.onload = null; script.onerror = null;
      if (error) { script.remove(); reject(error); } else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`Could not load ${name} renderer`)), 10000);
    script.onload = () => finish(typeof globalThis[globalName] === 'function' ? null : new Error(`Invalid ${name} renderer`));
    script.onerror = () => finish(new Error(`Could not load ${name} renderer`));
    document.head.append(script);
  }).catch(error => { bundleLoads.delete(name); throw error; });
  bundleLoads.set(name, loading);
  return loading;
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
const frames = new Map();
let refreshTimer, rendered = false, refreshRequested = false, snapshotForce = false, snapshotRequest = 0, snapshotApplied = 0, snapshotQueued = false, snapshotPreflightFailed = false;
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
window.addEventListener('lavish:ready', () => { if (startsInExplore(modeView)) globalThis.lavish?.setAnnotationMode?.(false); });
const labels = { commits: 'Commits', changes: 'Changes', tasks: 'Tasks' };
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
  try { response = await fetch(`${config.url}/action`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lavish-capability': config.capability }, body: JSON.stringify({ ...body, operation }), ...(['status', 'documents', 'snapshot', 'readDocument'].includes(operation) ? { signal: AbortSignal.timeout(10000) } : {}) }); }
  catch { throw new Error('Hub actions are unreachable. Your edits remain on this page. Local actions require the running hub owner.'); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Action failed');
  return data.result;
}
let navigationError = '', connectionStatus = 'Connecting…';
function status(text) {
  connectionStatus = text;
  const notice = navigationUncertain ? 'Navigation may still be in progress; select a destination to continue' : '';
  const connection = (navigationError || notice) && ['Connected', 'Connecting…'].includes(connectionStatus) ? '' : connectionStatus;
  document.querySelector('#connection').textContent = [navigationError, connection, notice].filter(Boolean).join(' · ');
}
function renderNav() {
  const nav = document.querySelector('#navigation'); nav.replaceChildren();
  for (const [id, label] of [...Object.entries(labels), ...documents.map(doc => [doc.id, doc.title])]) {
    const b = button(label, () => select(id)); if (id === selected) b.setAttribute('aria-current', 'page'); nav.append(b);
  }
}
let navigationRevision = 0, leavingConfirmed = false, navigationPending = false, editRevision = 0, pendingOwnerNavigation = 0;
let ownerNavigation = Promise.resolve(), refreshPaused = false, refreshPauseRevision = 0, attemptedSelection = '', navigationCancelled = false, navigationUncertain = false, leaveTimer;
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
  clearTimeout(leaveTimer); leavingConfirmed = false;
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
function leavePage(url, id) {
  pauseRefresh(); leavingConfirmed = true; attemptedSelection = id;
  if (!window.navigation) leaveTimer = setTimeout(() => { navigationUncertain = true; status(connectionStatus); resumeRefresh(); }, 1000);
  location.href = url;
}
window.navigation?.addEventListener('navigate', event => {
  if (leavingConfirmed) event.signal.addEventListener('abort', () => {
    navigationUncertain = false; navigationCancelled = true; navigationError = 'Navigation cancelled. Select a destination to try again.'; status(connectionStatus); resumeRefresh();
  }, { once: true });
});
window.addEventListener('pageshow', event => { if (event.persisted) { navigationUncertain = false; status(connectionStatus); resumeRefresh(); } });
function synchronizeNavigation(id) {
  pendingOwnerNavigation++;
  const request = ownerNavigation.then(() => action('navigate', { id }));
  ownerNavigation = request.catch(() => {}).finally(() => { pendingOwnerNavigation--; });
  return request;
}
for (const type of ['input', 'change']) document.addEventListener(type, event => { if (event.isTrusted) editRevision++; }, true);
function hasUnsavedDrafts() {
  return Boolean(diffView?.hasUnsavedDraft()) || [...drafts.values()].some(state => state.saving || state.text !== state.original);
}
window.addEventListener('beforeunload', event => {
  if (!leavingConfirmed && hasUnsavedDrafts()) { event.preventDefault(); event.returnValue = ''; }
});
async function select(id) {
  const doc = documents.find(item => item.id === id);
  const leavesPage = doc?.sibling && doc.source?.toLowerCase().endsWith('.html');
  if (navigationPending) return;
  navigationError = ''; status(connectionStatus);
  navigationPending = true;
  if (leavesPage) pauseRefresh();
  const revision = ++navigationRevision;
  try {
    let approved = false, approvedRevision = editRevision;
    if (leavesPage && hasUnsavedDrafts()) {
      approved = await globalThis.confirmDraftNavigation('Leaving discards unsaved hub drafts and unqueued comments.');
      if (!approved) return;
    }
    if (!leavesPage) {
      selected = id; renderNav();
      // A stale snapshot keeps rendering, but the view marks it as refreshing until
      // the request below replaces it, and a missing one shows its loading state.
      if (needsSnapshot(id)) { snapshotQueued = true; snapshotPreflightFailed = false; }
      const synchronization = synchronizeNavigation(id).then(() => {
        if (revision === navigationRevision) { attemptedSelection = ''; navigationCancelled = false; navigationUncertain = false; navigationError = ''; status(connectionStatus); }
      }, error => {
        if (revision === navigationRevision) { navigationError = error.message; status(connectionStatus); }
      });
      navigationPending = false;
      // Polling skips the snapshot on non-repository views, so entering one asks
      // for a current snapshot now instead of waiting for the next poll. A failed
      // earlier snapshot is retried the same way.
      if (needsSnapshot(id)) requestRefresh();
      await renderView();
      await synchronization;
      return;
    }
    await synchronizeNavigation(id);
    if (revision !== navigationRevision) return;
    if (leavesPage) {
      if ((!approved || approvedRevision !== editRevision) && hasUnsavedDrafts() && !(await globalThis.confirmDraftNavigation('Leaving discards unsaved hub drafts and unqueued comments.'))) return;
      const modeEditRevision = editRevision;
      if (startsInExplore(selected)) await globalThis.lavish?.setAnnotationMode?.(true);
      if (revision !== navigationRevision) return;
      if (modeEditRevision !== editRevision && hasUnsavedDrafts() && !(await globalThis.confirmDraftNavigation('Leaving discards unsaved hub drafts and unqueued comments.'))) return;
      navigationUncertain = false; navigationCancelled = false; status(connectionStatus);
      leavePage(new URL(doc.sibling, location.href).href, id); return;
    }
    selected = id; renderNav(); await renderView();
  } catch (error) { if (revision === navigationRevision) { navigationError = error.message; status(connectionStatus); } }
  finally { if (revision === navigationRevision) { navigationPending = false; if (leavesPage && !leavingConfirmed) resumeRefresh(); } }
}
const snapshotContent = value => value && JSON.stringify({ base: value.base, head: value.head, commits: value.commits, patch: value.patch });
async function refresh(force = false) {
  // A forced snapshot outlives the call that asked for it: the button and a save both
  // mean "the next snapshot must be uncached", and only the request below spends it.
  if (force) snapshotForce = true;
  // The first refresh runs even in a hidden tab so a page opened in the background
  // has content when it is shown; later polls wait for visibility instead.
  if (refreshPaused || busy || (tabHidden && rendered)) { queueRefresh(); return; } busy = true;
  // This run honours the owed follow-up; anything asked for while it runs is queued again.
  refreshRequested = false;
  const navigationAtStart = navigationRevision, navigationPendingAtStart = pendingOwnerNavigation > 0;
  let pauseRevision;
  try {
    const [state, list] = await Promise.all([action('status'), action('documents')]);
    if (refreshPaused) return;
    // The tab went hidden while status and documents were in flight. A snapshot costs
    // several jj runs, so a refresh that is no longer being watched leaves it to the
    // visibility catch-up rather than starting it in the background.
    if (tabHidden && rendered) return;
    let oldSelected = selected, oldDocuments = JSON.stringify(documents);
    const oldSnapshot = snapshotContent(snapshot), snapshotWasLoading = snapshotLoading();
    documents = list.documents;
    const remoteDoc = documents.find(item => item.id === state.selected);
    const remoteLeavesPage = remoteDoc?.sibling && remoteDoc.source?.toLowerCase().endsWith('.html');
    if (attemptedSelection && state.selected && state.selected !== attemptedSelection && !navigationPending && !pendingOwnerNavigation && !navigationPendingAtStart && navigationAtStart === navigationRevision) {
      attemptedSelection = '';
      if (navigationCancelled) { navigationCancelled = false; navigationError = ''; status(connectionStatus); }
    }
    if (state.selected && state.selected !== attemptedSelection && !navigationError && !navigationPending && !pendingOwnerNavigation && !navigationPendingAtStart && navigationAtStart === navigationRevision && !(remoteLeavesPage && (navigationUncertain || hasUnsavedDrafts()))) selected = state.selected;
    else if (remoteLeavesPage && hasUnsavedDrafts()) status('Navigation paused: unsaved drafts remain on this page.');
    const selectedDoc = documents.find(item => item.id === selected);
    if (!navigationError && selectedDoc?.sibling && selectedDoc.source?.toLowerCase().endsWith('.html')) {
      pauseRevision = pauseRefresh();
      if (startsInExplore(oldSelected)) await globalThis.lavish?.setAnnotationMode?.(true);
      if (navigationAtStart !== navigationRevision || navigationPending || pendingOwnerNavigation || hasUnsavedDrafts()) { selected = navigationAtStart === navigationRevision ? oldSelected : selected; if (pauseRevision === refreshPauseRevision) resumeRefresh(); return; }
      selected = oldSelected;
      leavePage(new URL(selectedDoc.sibling, location.href).href, selectedDoc.id); return;
    }
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
    const snapshotResult = request ? action('snapshot', { force: forced }).then(value => ({ value }), error => ({ error })) : null;
    const initialRender = !rendered;
    if (initialRender) { renderNav(); oldSelected = selected; oldDocuments = JSON.stringify(documents); await renderView(); }
    const result = await snapshotResult;
    if (navigationAtStart !== navigationRevision) oldSelected = selected;
    if (refreshPaused) return;
    // A settled request is spent whether or not it succeeded: the view has to drop its
    // loading notice and say the snapshot is unavailable. A paused refresh leaves it
    // unsettled so the catch-up asks again.
    if (request) snapshotApplied = request;
    if (result?.error) { snapshot = undefined; status(result.error.message); }
    else {
      if (result) snapshot = result.value;
      status(remoteLeavesPage && hasUnsavedDrafts() ? 'Navigation paused: unsaved drafts remain on this page.' : state.available ? 'Connected' : 'Workspace unavailable');
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
    // The loading flag is part of the comparison: a snapshot request that fails
    // before any snapshot exists must still replace the loading notice, and one
    // that settles back onto unchanged content must drop the refreshing notice.
    if ((initialRender && needsSnapshot(selected)) || !rendered || oldSelected !== selected || oldDocuments !== JSON.stringify(documents) || documentChanged || (needsSnapshot(selected) && (oldSnapshot !== snapshotContent(snapshot) || snapshotWasLoading !== snapshotLoading()))) {
      const active = document.activeElement;
      const label = active?.closest('#view') && active.getAttribute('aria-label');
      const selection = label && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
      const rendering = renderView();
      const generation = renderGeneration;
      await rendering;
      if (generation !== renderGeneration || documentNavigation !== navigationRevision) return;
      const createdFrame = frames.get(selected);
      if (!frame && createdFrame && htmlData) { createdFrame.version = htmlData.version; createdFrame.hash = htmlData.hash; }
      if (label) {
        const replacement = [...document.querySelectorAll('#view [aria-label]')].find(node => node.getAttribute('aria-label') === label);
        if (replacement) { replacement.focus(); if (selection) replacement.setSelectionRange(...selection); }
      }
    }
  } catch (error) {
    status(error.message);
    // The preflight failed before any snapshot request could be issued: the owed request
    // has to stop claiming to load, while it stays queued so the next poll asks again.
    if (snapshotQueued && !snapshotPreflightFailed) { snapshotPreflightFailed = true; if (needsSnapshot(selected)) await renderView(); }
    if (refreshPaused && pauseRevision === refreshPauseRevision && !navigationPending && !leavingConfirmed) resumeRefresh();
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
let renderGeneration = 0;
async function renderView(focusChangeId) {
  const generation = ++renderGeneration;
  const view = document.querySelector('#view'); diffView?.hide(); view.replaceChildren(); rendered = true;
  const id = selected;
  if (modeView !== id) {
    if (startsInExplore(id) || startsInExplore(modeView)) globalThis.lavish?.setAnnotationMode?.(!startsInExplore(id));
    modeView = id;
  }
  view.classList.toggle('changes-view', id === 'changes');
  for (const [key, frame] of frames) frame.node.hidden = key !== id || !documents.find(doc => doc.id === key)?.source?.toLowerCase().endsWith('.html');
  view.append(el('h1', labels[id] || documents.find(doc => doc.id === id)?.title || id));
  if (id === 'commits' || id === 'changes') {
    if (!snapshot) { view.append(notice(snapshotLoading() ? 'Loading repository snapshot…' : 'Repository snapshot unavailable. Refresh after checking the workspace and jj configuration.')); return; }
    view.append(el('p', `--from ${snapshot.base.slice(0, 12)} --to ${snapshot.head.slice(0, 12)}`, { class: 'muted' }));
    // Re-entering a repository view keeps the previous snapshot on screen while the
    // fresh one arrives, so say which of the two the owner is looking at.
    if (snapshotLoading()) view.append(el('p', 'Refreshing repository snapshot…', { class: 'muted' }));
    if (id === 'changes') {
      if (!(await requireBundle('diff', 'mountLavishDiff', view, generation))) return;
      view.append(diffContainer);
      if (!diffView) diffView = globalThis.mountLavishDiff(diffContainer, { embedded: true, loadDiffFiles: (operationId, fileIndex) => action('diffFiles', { operationId, fileIndex }) });
      diffView.update({ root: config.workspace, patch: snapshot.patch, range: `${snapshot.base} → ${snapshot.head}`, rangeSource: 'workspace snapshot', revision: snapshot.head, operationId: snapshot.operationId, kind: 'jj', to: snapshot.head });
      return;
    }
    if (!snapshot.commits.length) view.append(el('p', 'No commits in this range.'));
    for (const commit of snapshot.commits) {
      const key = `commit:${commit.changeId}`, state = draft(key, { text: commit.description, original: commit.description, commitId: commit.commitId, message: '', editing: false });
      if (state.awaitingSnapshot && (commit.commitId === state.awaitingSnapshot.commitId || snapshotApplied > state.awaitingSnapshot.after)) state.awaitingSnapshot = null;
      if (state.text === state.original && !state.saving && !state.message && !state.awaitingSnapshot) { state.text = commit.description; state.original = commit.description; state.commitId = commit.commitId; }
      const card = el('section', null, { class: 'card' }); card.append(el('h2', `${commit.changeId.slice(0, 12)} · ${commit.commitId.slice(0, 12)}`));
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
      frame = { node, url, version: doc.version, hash: undefined }; frames.set(id, frame);
    } else {
      frame.node.title = doc.title;
      if (frame.url !== url) { frame.url = url; frame.node.src = url; frame.version = doc.version; frame.hash = undefined; }
      frame.node.hidden = false;
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
          if (value && !value.startsWith('#') && !value.startsWith('/') && !/^[a-z][a-z\d+.-]*:/i.test(value)) node.setAttribute(attr, new URL(value, base).href);
        }
      },
      onError: error => { info.textContent = `Syntax highlighting unavailable: ${error.message}`; },
    });
    const edit = editButton(id === 'tasks' ? 'Tasks Markdown' : 'Document Markdown', () => { state.editing = true; toggle(); area.focus(); });
    edit.disabled = !!state.saving;
    const wrap = el('div', null, { class: 'commit-description-wrap' }); wrap.append(preview, edit);
    const controls = el('div', null, { class: 'commit-controls' }); controls.append(save, cancel);
    const toggle = () => { area.hidden = !state.editing; wrap.hidden = !!state.editing; controls.hidden = !state.editing; if (state.editing && id === 'tasks') { area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`; } if (!state.editing) render(); };
    view.append(wrap, area, controls); toggle();
  } else view.append(area, save);
  view.append(info);
}
app.innerHTML = '<header><div><strong>Workspace hub</strong><div id="workspace"></div></div><div><span id="connection" role="status">Connecting…</span> <button id="refresh" type="button">Refresh</button></div></header><div class="layout"><nav id="navigation" aria-label="Workspace views"></nav><div class="hub-content"><main id="view"></main><div id="frames"></div></div></div>';
document.querySelector('#workspace').textContent = config.workspace;
document.querySelector('#refresh').addEventListener('click', () => refresh(true));
refresh();
