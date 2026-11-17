const config = globalThis.hubConfig;
if (config.url.startsWith('/')) config.url = new URL(config.url, location.href).href;
const app = document.querySelector('#app');
const drafts = new Map();
const diffContainer = document.createElement('div'); diffContainer.className = 'hub-diff';
let diffView;
let selected = 'commits', snapshot, documents = [], busy = false;
const frames = new Map();
let refreshTimer, rendered = false, refreshRequested = false, snapshotRequest = 0, snapshotApplied = 0;
const labels = { commits: 'Commits', changes: 'Changes', tasks: 'Tasks' };
const el = (tag, text, attrs = {}) => { const node = document.createElement(tag); if (text != null) node.textContent = text; for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); return node; };
const button = (text, action) => { const node = el('button', text, { type: 'button' }); node.addEventListener('click', action); return node; };
async function action(operation, body = {}) {
  let response;
  try { response = await fetch(`${config.url}/action`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lavish-capability': config.capability }, body: JSON.stringify({ ...body, operation }), ...(['status', 'documents', 'snapshot', 'readDocument'].includes(operation) ? { signal: AbortSignal.timeout(10000) } : {}) }); }
  catch { throw new Error('Hub actions are unreachable. Your edits remain on this page. Local actions require the running hub owner.'); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Action failed');
  return data.result;
}
function status(text) { document.querySelector('#connection').textContent = text; }
function renderNav() {
  const nav = document.querySelector('#navigation'); nav.replaceChildren();
  for (const [id, label] of [...Object.entries(labels), ...documents.map(doc => [doc.id, doc.title])]) {
    const b = button(label, () => select(id)); if (id === selected) b.setAttribute('aria-current', 'page'); nav.append(b);
  }
}
let navigationRevision = 0, leavingConfirmed = false, navigationPending = false, editRevision = 0;
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
  navigationPending = true;
  const revision = ++navigationRevision;
  try {
    let approved = false, approvedRevision = editRevision;
    if (leavesPage && hasUnsavedDrafts()) {
      approved = await globalThis.confirmDraftNavigation('Leaving discards unsaved hub drafts and unqueued comments.');
      if (!approved) return;
    }
    await action('navigate', { id });
    if (revision !== navigationRevision) return;
    if (leavesPage) {
      if ((!approved || approvedRevision !== editRevision) && hasUnsavedDrafts() && !(await globalThis.confirmDraftNavigation('Leaving discards unsaved hub drafts and unqueued comments.'))) return;
      leavingConfirmed = true; location.href = new URL(doc.sibling, location.href).href; return;
    }
    selected = id; renderNav(); await renderView();
  } catch (error) { status(error.message); }
  finally { navigationPending = false; }
}
const snapshotContent = value => value && JSON.stringify({ base: value.base, head: value.head, commits: value.commits, patch: value.patch });
async function refresh(force = false) {
  if (busy) { if (force) refreshRequested = true; return; } busy = true;
  const navigationAtStart = navigationRevision;
  try {
    const [state, list] = await Promise.all([action('status'), action('documents')]);
    const oldSelected = selected, oldDocuments = JSON.stringify(documents), oldSnapshot = snapshotContent(snapshot);
    documents = list.documents;
    const remoteDoc = documents.find(item => item.id === state.selected);
    const remoteLeavesPage = remoteDoc?.sibling && remoteDoc.source?.toLowerCase().endsWith('.html');
    if (state.selected && !navigationPending && navigationAtStart === navigationRevision && !(remoteLeavesPage && hasUnsavedDrafts())) selected = state.selected;
    else if (remoteLeavesPage && hasUnsavedDrafts()) status('Navigation paused: unsaved drafts remain on this page.');
    const selectedDoc = documents.find(item => item.id === selected);
    if (selectedDoc?.sibling && selectedDoc.source?.toLowerCase().endsWith('.html')) { location.href = new URL(selectedDoc.sibling, location.href).href; return; }
    try { const request = ++snapshotRequest; snapshot = await action('snapshot', { force }); snapshotApplied = request; status(remoteLeavesPage && hasUnsavedDrafts() ? 'Navigation paused: unsaved drafts remain on this page.' : state.available ? 'Connected' : 'Workspace unavailable'); }
    catch (error) { snapshot = undefined; status(error.message); }
    let documentChanged = false;
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
    const doc = documents.find(item => item.id === selected);
    const frame = frames.get(selected);
    let htmlData;
    if (doc?.source?.toLowerCase().endsWith('.html')) {
      try {
        const data = await action('readDocument', { id: selected });
        htmlData = data;
        if (frame && (frame.version !== data.version || (frame.hash !== undefined && frame.hash !== data.hash))) { frame.version = data.version; frame.hash = data.hash; frame.node.src = frame.url; }
        else if (frame) { frame.version = data.version; frame.hash = data.hash; }
      } catch (error) { status(error.message); }
    }
    if (!rendered || oldSelected !== selected || oldDocuments !== JSON.stringify(documents)) renderNav();
    if (!rendered || oldSelected !== selected || oldDocuments !== JSON.stringify(documents) || documentChanged || (['commits', 'changes'].includes(selected) && oldSnapshot !== snapshotContent(snapshot))) {
      const active = document.activeElement;
      const label = active?.closest('#view') && active.getAttribute('aria-label');
      const selection = label && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
      await renderView();
      const createdFrame = frames.get(selected);
      if (!frame && createdFrame && htmlData) { createdFrame.version = htmlData.version; createdFrame.hash = htmlData.hash; }
      if (label) {
        const replacement = [...document.querySelectorAll('#view [aria-label]')].find(node => node.getAttribute('aria-label') === label);
        if (replacement) { replacement.focus(); if (selection) replacement.setSelectionRange(...selection); }
      }
    }
  } catch (error) { status(error.message); }
  finally {
    busy = false; clearTimeout(refreshTimer);
    if (refreshRequested) { refreshRequested = false; refresh(true); }
    else refreshTimer = setTimeout(refresh, 2000);
  }
}
function draft(key, initial) { if (!drafts.has(key)) drafts.set(key, initial); return drafts.get(key); }
function editor(label, value, onInput) { const area = el('textarea', null, { 'aria-label': label, rows: '5', spellcheck: 'false' }); area.value = value; area.addEventListener('input', () => onInput(area.value)); return area; }
function notice(text) { return el('p', text, { role: 'status', class: 'notice' }); }
async function renderView() {
  const view = document.querySelector('#view'); view.replaceChildren(); rendered = true;
  const id = selected;
  for (const [key, frame] of frames) frame.node.hidden = key !== id || !documents.find(doc => doc.id === key)?.source?.toLowerCase().endsWith('.html');
  view.append(el('h1', labels[id] || documents.find(doc => doc.id === id)?.title || id));
  if (id === 'commits' || id === 'changes') {
    if (!snapshot) { view.append(notice('Repository snapshot unavailable. Refresh after checking the workspace and jj configuration.')); return; }
    view.append(el('p', `Range ${snapshot.base.slice(0, 12)} → ${snapshot.head.slice(0, 12)}`, { class: 'muted' }));
    if (id === 'changes') {
      view.append(diffContainer);
      if (!diffView) diffView = globalThis.mountLavishDiff(diffContainer, { embedded: true });
      diffView.update({ root: config.workspace, patch: snapshot.patch, range: `${snapshot.base} → ${snapshot.head}`, rangeSource: 'workspace snapshot', revision: snapshot.head, kind: 'jj', to: snapshot.head });
      return;
    }
    if (!snapshot.commits.length) view.append(el('p', 'No commits in this range.'));
    for (const commit of snapshot.commits) {
      const key = `commit:${commit.changeId}`, state = draft(key, { text: commit.description, original: commit.description, commitId: commit.commitId, message: '', editing: false });
      if (state.awaitingSnapshot && (commit.commitId === state.awaitingSnapshot.commitId || snapshotApplied > state.awaitingSnapshot.after)) state.awaitingSnapshot = null;
      if (state.text === state.original && !state.saving && !state.message && !state.awaitingSnapshot) { state.text = commit.description; state.original = commit.description; state.commitId = commit.commitId; }
      const card = el('section', null, { class: 'card' }); card.append(el('h2', `${commit.changeId.slice(0, 12)} · ${commit.commitId.slice(0, 12)}`));
      const label = `Description ${commit.changeId.slice(0, 12)}`;
      const display = el('div', state.text || '(no description set)', { class: `commit-description${state.text ? '' : ' empty'}`, tabindex: '0', role: 'button', 'aria-label': `Edit ${label}` });
      const area = editor(label, state.text, value => { state.text = value; });
      area.className = 'commit-editor';
      display.hidden = state.editing; area.hidden = !state.editing;
      const edit = () => { if (commit.immutable || commit.divergent) return; state.editing = true; renderView(); };
      display.addEventListener('click', edit);
      display.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); edit(); } });
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
      if (state.message) { save.className = 'save-failed'; save.title = state.message; save.prepend(el('span', '⚠ ', { 'aria-hidden': 'true' })); }
      if (commit.immutable || commit.divergent) { display.removeAttribute('role'); display.removeAttribute('tabindex'); display.removeAttribute('aria-label'); save.title = commit.immutable ? 'Immutable commit' : 'Divergent change'; }
      const stats = el('pre', null, { class: 'commit-stat', 'aria-label': `Changes ${commit.changeId.slice(0, 12)}` });
      for (const part of (commit.stat || 'No changed files').split(/(\++|-+)/)) stats.append(el('span', part, { class: /^\++$/.test(part) ? 'stat-add' : /^-+$/.test(part) ? 'stat-remove' : '' }));
      const cancel = button('Cancel', () => { if (state.saving) return; state.text = state.original; state.message = ''; state.editing = false; renderView(); });
      cancel.disabled = !!state.saving;
      area.addEventListener('keydown', event => { if (event.key === 'Escape' && !state.saving) { event.preventDefault(); cancel.click(); } });
      save.hidden = cancel.hidden = !state.editing;
      card.append(display, area, save, cancel, info, stats); view.append(card);
      if (state.editing) area.focus();
      for (const [node, lines] of [[display, 8], [stats, 6]]) {
        if (!node.hidden) { const style = getComputedStyle(node); node.style.height = `${Math.min(node.scrollHeight, parseFloat(style.lineHeight) * lines + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom))}px`; }
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
  let state = drafts.get(`doc:${id}`);
  if (!state) {
    try { const data = await action('readDocument', { id }); state = draft(`doc:${id}`, { text: data.text, original: data.text, hash: data.hash, version: data.version, preview: true }); }
    catch (error) { if (selected === id) view.append(notice(error.message)); return; }
  }
  if (selected !== id) return;
  const info = notice(state.message || 'Ready');
  const area = editor(id === 'tasks' ? 'Tasks Markdown' : 'Document Markdown', state.text, value => { state.text = value; info.textContent = value === state.original ? 'Ready' : 'Unsaved changes'; });
  if (id === 'tasks') {
    const resize = () => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`; };
    area.addEventListener('input', resize);
    area.className = 'tasks-editor';
    requestAnimationFrame(resize);
  }
  const save = button('Save', async () => {
    const submitted = state.text; state.saving = true; save.disabled = true; info.textContent = 'Saving…';
    try {
      const result = await action('saveDocument', { id, version: state.version, baseHash: state.hash, text: submitted });
      state.message = result.reply;
      if (result.reply === 'Saved') { const data = await action('readDocument', { id }); if (data.version === state.version && data.text === submitted) { state.hash = data.hash; state.original = submitted; if (doc && state.text === submitted) state.preview = true; } else state.message = 'Saved, but the source changed afterwards. Your draft is retained.'; }
    } catch (error) { state.message = error.message; }
    state.saving = false; save.disabled = false; info.textContent = state.message;
    if (doc && state.preview && selected === id) renderView();
  });
  if (doc || id === 'tasks') {
    const preview = el('div', null, { class: 'hub-markdown', 'aria-label': 'Rendered Markdown' });
    const base = doc ? `${config.url}/resources/${config.resourceKey}/${encodeURIComponent(id)}/${encodeURIComponent(doc.source.split('/').pop())}` : location.href;
    const render = globalThis.hubMarkdownRenderer(area, preview, {
      hideFrontMatter: true,
      onTaskToggle: id === 'tasks' ? (line, checked) => {
        const lines = state.text.split('\n');
        lines[line] = lines[line].replace(/^((?:\s*>)*\s*(?:(?:[-*+]|\d+[.)])\s+)\[)[ xX](\])/, `$1${checked ? 'x' : ' '}$2`);
        state.text = lines.join('\n'); area.value = state.text; info.textContent = state.text === state.original ? 'Ready' : 'Unsaved changes';
      } : undefined,
      afterRender: root => {
        for (const node of root.querySelectorAll('[src], [href]')) for (const attr of ['src', 'href']) {
          const value = node.getAttribute(attr);
          if (value && !value.startsWith('#') && !value.startsWith('/') && !/^[a-z][a-z\d+.-]*:/i.test(value)) node.setAttribute(attr, new URL(value, base).href);
        }
      },
      onError: error => { info.textContent = `Syntax highlighting unavailable: ${error.message}`; },
    });
    if (id === 'tasks') {
      const edit = button('✎', () => { state.editing = !state.editing; toggle(); });
      edit.setAttribute('aria-label', 'Edit Tasks Markdown');
      const toggle = () => { area.hidden = !state.editing; preview.hidden = !!state.editing; edit.setAttribute('aria-pressed', String(!!state.editing)); if (state.editing) { area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`; area.focus(); } else render(); };
      view.append(edit, area, preview, save); toggle();
    } else {
      const edit = button('Edit', () => { state.preview = false; toggle(); });
      const rendered = button('Preview', () => { state.preview = true; toggle(); });
      const toggle = () => { area.hidden = !!state.preview; preview.hidden = !state.preview; edit.setAttribute('aria-pressed', String(!state.preview)); rendered.setAttribute('aria-pressed', String(!!state.preview)); if (state.preview) render(); };
      view.append(edit, rendered, area, preview, save); toggle();
    }
  } else view.append(area, save);
  view.append(info);
}
app.innerHTML = '<header><div><strong>Workspace hub</strong><div id="workspace"></div></div><div><span id="connection" role="status">Connecting…</span> <button id="refresh" type="button">Refresh</button></div></header><div class="layout"><nav id="navigation" aria-label="Workspace views"></nav><div><main id="view"></main><div id="frames"></div></div></div>';
document.querySelector('#workspace').textContent = config.workspace;
document.querySelector('#refresh').addEventListener('click', () => refresh(true));
refresh();
