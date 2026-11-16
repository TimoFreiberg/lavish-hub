const config = globalThis.hubConfig;
const app = document.querySelector('#app');
const drafts = new Map();
let selected = 'commits', snapshot, documents = [], busy = false;
const labels = { commits: 'Commits', changes: 'Changes', tasks: 'Tasks', pr: 'PR draft' };
const el = (tag, text, attrs = {}) => { const node = document.createElement(tag); if (text != null) node.textContent = text; for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); return node; };
const button = (text, action) => { const node = el('button', text, { type: 'button' }); node.addEventListener('click', action); return node; };
async function action(operation, body = {}) {
  let response;
  try { response = await fetch(`${config.url}/action`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lavish-capability': config.capability }, body: JSON.stringify({ ...body, operation }) }); }
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
async function select(id) {
  try { await action('navigate', { id }); selected = id; renderNav(); await renderView(); }
  catch (error) { status(error.message); }
}
async function refresh() {
  if (busy) return; busy = true; status('Refreshing…');
  try {
    const [state, list] = await Promise.all([action('status'), action('documents')]);
    documents = list.documents;
    if (state.selected) selected = state.selected;
    try { snapshot = await action('snapshot'); status(state.available ? 'Connected' : 'Workspace unavailable'); }
    catch (error) { snapshot = undefined; status(error.message); }
    const active = document.activeElement;
    const label = active?.tagName === 'TEXTAREA' ? active.getAttribute('aria-label') : null;
    const selection = label ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
    const cached = drafts.get(`doc:${selected}`);
    if (cached && cached.text === cached.original && !cached.saving) {
      try {
        const data = await action('readDocument', { id: selected });
        // Do not replace a draft edited while the read was in flight.
        if (cached.text === cached.original && !cached.saving) Object.assign(cached, { text: data.text, original: data.text, hash: data.hash, version: data.version, message: '' });
      } catch (error) { cached.message = error.message; }
    }
    renderNav(); await renderView();
    if (label) {
      const replacement = [...document.querySelectorAll('#view textarea')].find(node => node.getAttribute('aria-label') === label);
      if (replacement) { replacement.focus(); replacement.setSelectionRange(...selection); }
    }
  } catch (error) { status(error.message); }
  finally { busy = false; }
}
function draft(key, initial) { if (!drafts.has(key)) drafts.set(key, initial); return drafts.get(key); }
function editor(label, value, onInput) { const area = el('textarea', null, { 'aria-label': label, rows: '5', spellcheck: 'false' }); area.value = value; area.addEventListener('input', () => onInput(area.value)); return area; }
function notice(text) { return el('p', text, { role: 'status', class: 'notice' }); }
async function renderView() {
  const view = document.querySelector('#view'); view.replaceChildren();
  const id = selected; view.append(el('h1', labels[id] || documents.find(doc => doc.id === id)?.title || id));
  if (id === 'commits' || id === 'changes') {
    if (!snapshot) { view.append(notice('Repository snapshot unavailable. Refresh after checking the workspace and jj configuration.')); return; }
    view.append(el('p', `Range ${snapshot.base.slice(0, 12)} → ${snapshot.head.slice(0, 12)}`, { class: 'muted' }));
    if (id === 'changes') { view.append(el('pre', snapshot.patch || 'No changes.')); return; }
    const stats = button(snapshot.stat || 'No changed files', () => select('changes')); stats.className = 'stats'; view.append(stats);
    if (!snapshot.commits.length) view.append(el('p', 'No commits in this range.'));
    for (const commit of snapshot.commits) {
      const key = `commit:${commit.changeId}`, state = draft(key, { text: commit.description, original: commit.description, commitId: commit.commitId, message: '' });
      if (state.text === state.original && !state.saving) { state.text = commit.description; state.original = commit.description; state.commitId = commit.commitId; }
      const card = el('section', null, { class: 'card' }); card.append(el('h2', `${commit.changeId.slice(0, 12)} · ${commit.commitId.slice(0, 12)}`));
      const info = notice(state.message || (commit.immutable ? 'Immutable' : commit.divergent ? 'Divergent change' : 'Ready'));
      const area = editor(`Description ${commit.changeId.slice(0, 12)}`, state.text, value => { state.text = value; info.textContent = value === state.original ? 'Ready' : 'Unsaved changes'; });
      const save = button('Save description', async () => {
        const submitted = state.text; state.saving = true; save.disabled = true; info.textContent = 'Saving…';
        try {
          const result = await action('describe', { changeId: commit.changeId, commitId: state.commitId, expectedDescription: state.original, description: submitted });
          if (result.status !== 'saved') { state.message = `Conflict: ${result.reason}. Current description: ${result.current?.map(row => row.description).join(' / ') || '(unavailable)'}`; }
          else { state.original = result.current.description; state.commitId = result.current.commitId; if (state.text === submitted) { state.text = state.original; area.value = state.text; } state.message = 'Saved'; }
        } catch (error) { state.message = error.message; }
        state.saving = false; save.disabled = false; info.textContent = state.message;
      });
      save.disabled = commit.immutable || commit.divergent; card.append(area, save, info); view.append(card);
    }
    return;
  }
  const doc = documents.find(item => item.id === id);
  if (doc?.metadata && Object.keys(doc.metadata).length) { const scope = el('p', Object.entries(doc.metadata).map(([key, value]) => `${key}: ${value}`).join(' · '), { class: 'muted' }); view.append(scope); }
  if (doc?.source?.toLowerCase().endsWith('.html')) {
    const file = doc.source.split('/').pop();
    const frame = el('iframe', null, { title: doc.title, sandbox: 'allow-scripts allow-forms allow-popups allow-downloads', referrerpolicy: 'no-referrer', src: `${config.url}/resources/${config.resourceKey}/${encodeURIComponent(id)}/${encodeURIComponent(file)}` });
    frame.className = 'published-document'; view.append(frame); return;
  }
  let state = drafts.get(`doc:${id}`);
  if (!state) {
    try { const data = await action('readDocument', { id }); state = draft(`doc:${id}`, { text: data.text, original: data.text, hash: data.hash, version: data.version }); }
    catch (error) { if (selected === id) view.append(notice(error.message)); return; }
  }
  if (selected !== id) return;
  if (id === 'tasks') {
    view.append(el('p', 'Toggle or edit checklist items, or edit the Markdown source below. Save to write your changes.'));
    const list = el('ol', null, { 'aria-label': 'Tasks checklist' });
    const lines = state.text.split('\n');
    lines.forEach((line, index) => {
      const match = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*)$/.exec(line);
      if (!match) return;
      const item = el('li');
      const toggle = el('input', null, { type: 'checkbox', 'aria-label': `Complete task ${list.children.length + 1}` });
      toggle.checked = match[2].toLowerCase() === 'x';
      const text = el('input', null, { type: 'text', 'aria-label': `Task ${list.children.length + 1}` }); text.value = match[4];
      const update = () => { lines[index] = `${match[1]}${toggle.checked ? 'x' : ' '}${match[3]}${text.value}`; state.text = lines.join('\n'); area.value = state.text; info.textContent = 'Unsaved changes'; };
      toggle.addEventListener('change', update); text.addEventListener('input', update);
      item.append(toggle, text); list.append(item);
    });
    view.append(list);
    view.append(button('Add task', () => { state.text += `${state.text && !state.text.endsWith('\n') ? '\n' : ''}- [ ] New task\n`; renderView(); }));
  }
  if (id === 'pr') view.append(el('p', 'Use # title followed by the body. Launch saves this draft before opening an interactive PR command.'));
  const info = notice(state.message || 'Ready');
  const area = editor(id === 'pr' ? 'PR Markdown' : id === 'tasks' ? 'Tasks Markdown' : 'Document Markdown', state.text, value => { state.text = value; info.textContent = value === state.original ? 'Ready' : 'Unsaved changes'; });
  if (id === 'tasks') area.addEventListener('input', () => {
    view.querySelectorAll('ol input').forEach(control => { control.disabled = true; });
  });
  const save = button('Save', async () => {
    const submitted = state.text; state.saving = true; save.disabled = true; info.textContent = 'Saving…';
    try {
      const result = await action('saveDocument', { id, version: state.version, baseHash: state.hash, text: submitted });
      state.message = result.reply;
      if (result.reply === 'Saved') { const data = await action('readDocument', { id }); if (data.version === state.version && data.text === submitted) { state.hash = data.hash; state.original = submitted; } else state.message = 'Saved, but the source changed afterwards. Your draft is retained.'; }
    } catch (error) { state.message = error.message; }
    state.saving = false; save.disabled = false; info.textContent = state.message;
  });
  view.append(area, save);
  if (id === 'pr') {
    const launch = button('Launch PR command', async () => {
      const submitted = state.text; state.saving = true; launch.disabled = true; save.disabled = true; info.textContent = 'Saving and preparing launch…';
      try {
        const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
        const result = await action('launchPr', { id: requestId, version: state.version, baseHash: state.hash, text: submitted });
        if (result.savedHash) { state.hash = result.savedHash; state.original = submitted; }
        state.message = [result.message, result.revision && `Submitted revision: ${result.revision}`, result.warning, result.command && result.status !== 'launched' && result.command].filter(Boolean).join('\n');
      } catch (error) { state.message = `${error.message} Launch outcome may be unknown; check the terminal before retrying.`; }
      state.saving = false; launch.disabled = false; save.disabled = false; info.textContent = state.message;
    });
    view.append(launch);
  }
  view.append(info);
}
app.innerHTML = '<header><div><strong>Workspace hub</strong><div id="workspace"></div></div><div><span id="connection" role="status">Connecting…</span> <button id="refresh" type="button">Refresh</button></div></header><div class="layout"><nav id="navigation" aria-label="Workspace views"></nav><main id="view"></main></div>';
document.querySelector('#workspace').textContent = config.workspace;
document.querySelector('#refresh').addEventListener('click', refresh);
refresh();
