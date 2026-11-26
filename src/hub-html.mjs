import { parse, parseFragment, serializeOuter } from 'parse5';
import { themeCss } from './orangebox.mjs';

const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

function siblingSidebarClient(c) {
  c.url = new URL(c.url, location.href).href;
  const { formatTabTitle, applyNavBadge, applyCollapseToggle, createLeaveGuard, createOlderDisclosureController, createSafeStorage, attachResizablePane } = globalThis.lavishHubLifecycle;
  const builtinViews = { diff: 'Diff', tasks: 'Tasks' };
  const sidebar = document.querySelector('#lavish-hub-sidebar');
  const sidebarToggle = sidebar.querySelector('.sidebar-toggle');
  const resizer = sidebar.querySelector('.sidebar-resizer');
  function renderSidebar({ width, collapsed }) {
    document.documentElement.style.setProperty('--lavish-hub-sidebar-width', collapsed ? '38px' : `${width}px`);
    sidebar.classList.toggle('is-collapsed', collapsed);
    sidebarToggle.textContent = collapsed ? '»' : '«';
    sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
    sidebarToggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    sidebarToggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  }
  const pane = attachResizablePane({ storage: createSafeStorage(), widthKey: 'lavish-hub-sidebar-width', collapsedKey: 'lavish-hub-sidebar-collapsed', defaultWidth: 200, minWidth: 160, maxWidth: 420, onChange: renderSidebar });
  renderSidebar(pane.getState());
  sidebarToggle.addEventListener('click', () => pane.setCollapsed(!pane.getState().collapsed));
  pane.attachResizer(resizer, event => event.clientX);
  const setTabTitle = () => {
    const title = formatTabTitle('', c.sessionTitle || c.repoName || c.workspaceName || '');
    document.title = title;
    globalThis.lavish?.setDocumentMeta?.({ title });
  };
  setTabTitle();
  window.addEventListener('lavish:ready', () => { setTabTitle(); syncUrl({ view: c.id, hash: currentHash, mode: 'replace' }); });
  let currentHash = location.hash, queuedUrlChange = null;
  function syncUrl(update) {
    if (globalThis.lavish?.syncUrl) globalThis.lavish.syncUrl(update);
    else if (window.self === window.top && location.protocol !== 'about:') {
      const url = new URL(location.href); url.searchParams.set('view', update.view); url.hash = update.hash;
      const next = url.pathname + url.search + url.hash;
      if (next !== location.pathname + location.search + location.hash) history[update.mode === 'push' ? 'pushState' : 'replaceState'](null, '', next);
    }
  }
  function replaceFrameHash(hash) { if (window.self !== window.top) history.replaceState(null, '', location.pathname + location.search + hash); }
  function scrollToFragment(hash) {
    let id; try { id = decodeURIComponent(hash.slice(1)); } catch { id = hash.slice(1); }
    if (!id || id === 'top') { window.scrollTo(0, 0); return; }
    (document.getElementById(id) || document.getElementsByName(id)[0])?.scrollIntoView();
  }
  syncUrl({ view: c.id, hash: currentHash, mode: 'replace' });
  if (currentHash) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => scrollToFragment(currentHash), { once: true });
    else scrollToFragment(currentHash);
    window.addEventListener('load', () => scrollToFragment(currentHash), { once: true });
  }
  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.('a[href^="#"]');
    if (!a || a.closest('[data-lavish-action],[data-lavish-ui]') || a.hasAttribute('download') || (a.target && a.target !== '_self')) return;
    const hash = a.getAttribute('href'); e.preventDefault(); currentHash = hash;
    replaceFrameHash(hash); syncUrl({ view: c.id, hash, mode: 'push' }); scrollToFragment(hash);
  });
  let navigating = false, dirty = false, edits = 0, navGeneration = 0;
  let paused = false, polling = false, timer, readController, readTimer;
  let lastSelectionRevision = null, notificationBaseline = false, toastTimer;
  const seenDocs = new Map();
  let warmed = false, catchup = false, acknowledged = false, ackPending = false;
  let pendingUpdate = null, flashedVersion = '', flashTimer, lavishRetryTimer, lastLavishInputAt = 0;
  const touched = new Set(), initialEditable = new WeakMap();
  const nav = document.querySelector('#lavish-hub-sidebar nav');
  const primary = nav.querySelector('.nav-primary'), details = nav.querySelector('.nav-older'), older = details.querySelector('.nav-older-list');
  const disclosure = createOlderDisclosureController({ initialOpen: details.open });
  let collapseRevision = 0, pinnedActive = Boolean(primary.querySelector('[data-current]'));
  function syncOlder() {
    const count = older.children.length;
    details.querySelector('.nav-older-count').textContent = String(count);
    disclosure.sync(details, { count, activeOlderId: older.querySelector('[data-current]') ? c.id : null });
  }
  details.addEventListener('toggle', () => disclosure.onUserToggle(details));
  syncOlder();
  const feedback = document.querySelector('#lavish-hub-sidebar [role=status]');
  const toast = document.querySelector('#lavish-hub-toast');
  function hideToast() { clearTimeout(toastTimer); toast.hidden = true; }
  function showToast(id, label) {
    clearTimeout(toastTimer);
    const text = document.createElement('span'); text.textContent = label;
    const open = document.createElement('button'); open.type = 'button'; open.textContent = 'Open';
    open.addEventListener('click', () => { hideToast(); const link = [...nav.querySelectorAll('a[data-hub-id]')].find(a => a.dataset.hubId === id); link?.click(); });
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = '×'; dismiss.setAttribute('aria-label', 'Dismiss notification'); dismiss.addEventListener('click', hideToast);
    toast.replaceChildren(text, open, dismiss); toast.hidden = false; toastTimer = setTimeout(hideToast, 6000);
  }
  function noteUpdates(state, list) {
    let notice;
    for (const doc of list) {
      const previous = seenDocs.get(doc.id);
      if (notificationBaseline && doc.id !== c.id) {
        const kind = !previous ? 'New' : previous.version !== doc.version ? 'Updated' : '';
        if (kind) notice = { id: doc.id, label: kind + ': ' + doc.title };
      }
      seenDocs.set(doc.id, { version: doc.version });
    }
    const selectionTarget = state.selectionTarget ?? state.selected;
    if (notificationBaseline && !notice && !leaveGuard.isLeaving() && state.selectionRevision > lastSelectionRevision && selectionTarget && selectionTarget !== c.id) {
      const title = builtinViews[selectionTarget] || list.find(doc => doc.id === selectionTarget)?.title || selectionTarget;
      notice = { id: selectionTarget, label: 'Selected: ' + title };
    }
    if (typeof state.selectionRevision === 'number') lastSelectionRevision = Math.max(lastSelectionRevision ?? state.selectionRevision, state.selectionRevision);
    notificationBaseline = true;
    if (notice) showToast(notice.id, notice.label);
  }
  function pause() { paused = true; clearTimeout(timer); readController?.abort(); }
  function resume() {
    if (!paused) return;
    paused = false; nav.removeAttribute('aria-busy');
    if (!feedback.hasAttribute('data-error')) feedback.textContent = leaveGuard.isUncertain() ? 'Navigation may still be in progress; select a destination to continue' : '';
    if (!polling) timer = setTimeout(refresh, 0);
  }
  const leaveGuard = createLeaveGuard({
    isDirty: () => { syncDirty(); return dirty; }, onPause: pause,
    onResume: () => { resume(); if (!navigating && queuedUrlChange) { const next = queuedUrlChange; queuedUrlChange = null; handleUrlChange(next); } },
    onStatus: () => { if (leaveGuard.isCancelled()) { feedback.dataset.error = ''; feedback.textContent = 'Navigation cancelled. Select a destination to try again.'; } },
  });
  function applyUpdate(update) {
    if (update.samePage) leaveGuard.reload(); else leaveGuard.leave(update.dest);
  }
  const docUrl = (doc, id = doc?.id) => new URL(doc?.source?.toLowerCase().endsWith('.html') ? doc.sibling : 'hub.html?__lavish_hub_view=' + encodeURIComponent(id), location.href);
  const canAutoReload = generation => (generation === undefined || generation === navGeneration) && !navigating && !leaveGuard.isLeaving() && !leaveGuard.isUncertain() && !feedback.hasAttribute('data-error');
  function maybeApplyPendingUpdate(generation) {
    if (!pendingUpdate || dirty || !canAutoReload(generation)) return false;
    if (Date.now() - lastLavishInputAt < 250) {
      clearTimeout(lavishRetryTimer); lavishRetryTimer = setTimeout(() => { syncDirty(); maybeApplyPendingUpdate(); }, 260);
      return false;
    }
    applyUpdate(pendingUpdate); return true;
  }
  const isAuthoredTarget = target => target instanceof Element && !target.closest('[data-lavish-action],[data-lavish-ui]');
  document.addEventListener('beforeinput', e => {
    if (!e.isTrusted || !isAuthoredTarget(e.target)) return;
    const host = e.target.closest('[contenteditable]');
    if (host && !initialEditable.has(host)) initialEditable.set(host, host.innerHTML);
  }, true);
  function trackControl(target) {
    if (target.tagName === 'INPUT' && target.type === 'radio' && target.name) {
      for (const radio of document.querySelectorAll('input[type="radio"]')) {
        if (radio.name === target.name && radio.form === target.form) touched.add(radio);
      }
    } else if (target.isContentEditable) touched.add(target.closest('[contenteditable]') || target);
    else touched.add(target);
  }
  function isControlDirty(el) {
    if (!el.isConnected) { touched.delete(el); return false; }
    if (el.tagName === 'INPUT') {
      if (el.type === 'checkbox' || el.type === 'radio') return el.checked !== el.defaultChecked;
      if (el.type === 'file') return Boolean(el.files?.length);
      return el.value !== el.defaultValue;
    }
    if (el.tagName === 'TEXTAREA') return el.value !== el.defaultValue;
    if (el.tagName === 'SELECT') {
      const options = [...el.options];
      if (!el.multiple) {
        const selected = options.filter(option => option.defaultSelected).at(-1);
        const fallback = el.size <= 1 ? options.find(option => !option.disabled && !(option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled)) : undefined;
        const defaultOption = selected || fallback;
        if (defaultOption) return options.some(option => option.selected !== (option === defaultOption));
      }
      return options.some(option => option.selected !== option.defaultSelected);
    }
    if (initialEditable.has(el)) return el.innerHTML !== initialEditable.get(el);
    return true;
  }
  function syncDirty() { dirty = [...touched].some(isControlDirty); }
  function recomputeDirty() {
    const wasDirty = dirty;
    syncDirty();
    if (wasDirty && !dirty) maybeApplyPendingUpdate();
  }
  for (const type of ['input', 'change']) document.addEventListener(type, e => {
    if (!e.isTrusted) return;
    if (type === 'input' && e.target instanceof Element && e.target.closest('[data-lavish-ui]')) lastLavishInputAt = Date.now();
    if (isAuthoredTarget(e.target)) { trackControl(e.target); recomputeDirty(); if (dirty) edits++; }
  }, true);
  document.addEventListener('reset', e => { if (isAuthoredTarget(e.target)) setTimeout(recomputeDirty, 0); }, true);
  const action = async (operation, body = {}, signal) => {
    const response = await fetch(c.url + '/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lavish-capability': c.capability }, body: JSON.stringify({ ...body, operation }), ...(signal ? { signal } : {}) });
    const data = await response.json().catch(() => ({}));
    leaveGuard.handleUnauthorized(response, data);
    if (!response.ok) throw Error(data.error || 'Hub action failed');
    return data.result;
  };
  for (const a of nav.querySelectorAll('a')) a.href = new URL(a.getAttribute('href'), location.href).href;
  const readyToAck = () => document.readyState !== 'loading';
  const acknowledgeCurrent = () => {
    if (!readyToAck() || acknowledged || ackPending || !c.version) return;
    ackPending = true;
    action('acknowledge', { id: c.id, version: c.version }, AbortSignal.timeout(10000)).then(() => { acknowledged = true; }, () => {}).finally(() => { ackPending = false; });
  };
  if (readyToAck()) acknowledgeCurrent(); else document.addEventListener('DOMContentLoaded', acknowledgeCurrent, { once: true });
  async function navigateTo(id, targetUrl, labelText, fromPopstate = false) {
    if (navigating || leaveGuard.isLeaving()) return;
    leaveGuard.clearCancelled(); syncDirty(); navigating = true; pause(); navGeneration++;
    feedback.removeAttribute('data-error'); feedback.textContent = 'Opening ' + labelText + '…'; nav.setAttribute('aria-busy', 'true');
    try {
      const approved = await leaveGuard.confirmTwice('Leaving discards unsaved document edits.', () => edits, () => action('navigate', { id }, AbortSignal.timeout(10000)));
      if (!approved) return;
      if (queuedUrlChange) return;
      leaveGuard.clearUncertain();
      if (!fromPopstate) syncUrl({ view: id, hash: '', mode: 'push' });
      leaveGuard.leave(targetUrl);
    } catch { feedback.dataset.error = ''; feedback.textContent = 'Could not open ' + labelText + '. Select it again to retry.'; }
    finally {
      navigating = false;
      if (!leaveGuard.isLeaving()) {
        resume(); nav.removeAttribute('aria-busy'); if (!feedback.hasAttribute('data-error')) feedback.textContent = leaveGuard.isUncertain() ? 'Navigation may still be in progress; select a destination to continue' : '';
        if (queuedUrlChange) { const next = queuedUrlChange; queuedUrlChange = null; if (!next.view || next.view === c.id) action('navigate', { id: c.id }, AbortSignal.timeout(10000)).catch(() => {}); handleUrlChange(next); }
        else if (fromPopstate) syncUrl({ view: c.id, hash: currentHash, mode: 'push' });
      }
    }
  }
  function parseDeepLink(href) {
    if (typeof href !== 'string' || !/^(?:hub\.html)?\?/.test(href)) return null;
    const url = new URL(href, 'https://hub.invalid/'), view = url.searchParams.get('view') || '';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(view)) return null;
    return { view, params: url.searchParams };
  }
  function markDeepLinks() {
    for (const link of document.querySelectorAll('a[href]')) {
      if (!link.closest('#lavish-hub-sidebar') && parseDeepLink(link.getAttribute('href'))) link.setAttribute('data-lavish-action', '');
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', markDeepLinks, { once: true });
  else markDeepLinks();
  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.('a[href]');
    if (!a || a.closest('#lavish-hub-sidebar') || a.hasAttribute('download') || (a.target && a.target !== '_self')) return;
    const target = parseDeepLink(a.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    const link = [...nav.querySelectorAll('a[data-hub-id]')].find(item => item.dataset.hubId === target.view);
    if (!link && !Object.hasOwn(builtinViews, target.view)) {
      feedback.dataset.error = ''; feedback.textContent = `Unknown view "${target.view}".`; return;
    }
    const sibling = link && new URL(link.href).pathname.endsWith('.html') && !new URL(link.href).pathname.endsWith('/hub.html');
    const params = new URLSearchParams();
    for (const key of ['view', 'file', 'line', 'side', 'change']) if (target.params.has(key)) params.set(`__lavish_hub_${key}`, target.params.get(key));
    const destination = sibling ? link.href : new URL('hub.html?' + params, location.href).href;
    navigateTo(target.view, destination, link?.querySelector('.nav-label')?.textContent || target.view);
  });
  nav.addEventListener('click', async e => {
    const toggle = e.target.closest('button.nav-collapse-toggle');
    if (toggle && nav.contains(toggle)) {
      e.preventDefault();
      const { hubId: id, hubVersion: version, hubCollapsed } = toggle.dataset, collapsed = hubCollapsed !== 'true';
      toggle.disabled = true; collapseRevision++;
      try {
        await action('setDocumentCollapsed', { id, version, collapsed }, AbortSignal.timeout(10000));
        if (id === c.id) pinnedActive = !collapsed;
        toggle.dataset.hubCollapsed = String(collapsed);
        const row = toggle.closest('.nav-row'), title = row.querySelector('.nav-label').textContent;
        applyCollapseToggle(toggle, title, collapsed);
        feedback.removeAttribute('data-error'); feedback.textContent = '';
        (collapsed ? older : primary).append(row); syncOlder(); collapseRevision++; toggle.disabled = false;
        if (!toggle.closest('details:not([open])')) toggle.focus(); else details.querySelector('summary').focus();
        catchup = true;
        if (!polling && !paused) { clearTimeout(timer); timer = setTimeout(refresh, 0); }
      } catch (error) { feedback.dataset.error = ''; feedback.textContent = error.message; }
      finally { toggle.disabled = false; }
      return;
    }
    const reload = e.target.closest('button.nav-reload');
    if (reload && nav.contains(reload)) { e.preventDefault(); if (!navigating && !leaveGuard.isLeaving() && pendingUpdate) applyUpdate(pendingUpdate); return; }
    const a = e.target.closest('a[data-hub-id]');
    if (!a || !nav.contains(a)) return;
    e.preventDefault();
    navigateTo(a.dataset.hubId, a.href, a.querySelector('.nav-label')?.textContent || a.textContent);
  });
  function handleUrlChange({ view, hash = '' }) {
    if (leaveGuard.isLeaving()) { queuedUrlChange = { view, hash }; return; }
    if (navigating) { queuedUrlChange = { view, hash }; return; }
    if (!view || view === c.id) { syncUrl({ view: c.id, hash, mode: 'replace' }); currentHash = hash; replaceFrameHash(hash); scrollToFragment(hash); return; }
    const a = [...nav.querySelectorAll('a[data-hub-id]')].find(link => link.dataset.hubId === view);
    const target = a ? new URL(a.href) : docUrl(null, view);
    target.hash = hash;
    navigateTo(view, target.href, a?.querySelector('.nav-label')?.textContent || view, true);
  }
  window.addEventListener('lavish:urlChange', e => handleUrlChange(e.detail));
  window.addEventListener('popstate', () => { if (window.self === window.top && !globalThis.lavish?.syncUrl) handleUrlChange({ view: new URLSearchParams(location.search).get('view') || '', hash: location.hash }); });
  async function refresh() {
    if (paused || polling || (warmed && document.visibilityState === 'hidden')) return;
    warmed = true; polling = true;
    const generation = navGeneration, collapseAtStart = collapseRevision;
    readController = new AbortController(); readTimer = setTimeout(() => readController?.abort(), 10000);
    try {
      const [state, list] = await Promise.all([action('status', {}, readController.signal), action('documents', {}, readController.signal)]);
      if (paused) return;
      const nextTitle = state.title || '';
      if (nextTitle !== (c.sessionTitle || '')) {
        c.sessionTitle = nextTitle;
        const title = document.querySelector('#lavish-hub-sidebar .hub-session-title');
        if (title) { title.textContent = nextTitle; title.hidden = !nextTitle; }
        const name = document.querySelector('#lavish-hub-sidebar .hub-repo-name');
        if (name) name.textContent = c.session || nextTitle ? c.repoName : c.workspaceName;
        setTabTitle();
      }
      if (!acknowledged) acknowledgeCurrent();
      noteUpdates(state, list.documents);
      syncDirty();
      const current = list.documents.find(d => d.id === c.id);
      if (current && c.version && current.version && current.version !== c.version) {
        const dest = docUrl(current);
        pendingUpdate = { version: current.version, dest: dest.href, samePage: dest.pathname === location.pathname };
        if (maybeApplyPendingUpdate(generation)) return;
      } else pendingUpdate = null;
      if (collapseAtStart !== collapseRevision) {
        for (const doc of list.documents) {
          const toggle = [...nav.querySelectorAll('.nav-collapse-toggle')].find(item => item.dataset.hubId === doc.id && item.dataset.hubVersion === doc.version);
          if (toggle) doc.collapsed = toggle.dataset.hubCollapsed === 'true';
        }
        catchup = true;
      }
      const items = [...Object.entries(builtinViews).map(([id, title]) => ({ id, title, unseen: false })), ...list.documents.map(d => ({ ...d, unseen: d.id === c.id ? d.version !== c.version : d.viewedVersion !== d.version }))];
      const focused = nav.contains(document.activeElement) ? document.activeElement : null;
      const existing = new Map([...nav.querySelectorAll('a[data-hub-id]')].map(a => [a.dataset.hubId, a]));
      const next = new Map([[primary, primary.firstElementChild], [older, older.firstElementChild]]);
      for (const item of items) {
        const a = existing.get(item.id) || document.createElement('a'); existing.delete(item.id); a.dataset.hubId = item.id;
        let row = a.parentElement?.classList.contains('nav-row') ? a.parentElement : null;
        if (!row) {
          row = document.createElement('div'); row.className = 'nav-row';
          const parent = a.parentElement;
          if (parent === primary || parent === older) { parent.insertBefore(row, a); if (next.get(parent) === a) next.set(parent, row); }
          row.append(a);
        }
        row.toggleAttribute('data-current', item.id === c.id);
        let label = a.querySelector('.nav-label');
        if (!label) { label = document.createElement('span'); label.className = 'nav-label'; a.replaceChildren(label); }
        if (label.textContent !== item.title) label.textContent = item.title;
        const unseen = item.unseen && !(item.id === c.id && pendingUpdate);
        applyNavBadge(a, unseen ? 'new' : '', 'lavish-hub-desc');
        const href = docUrl(item).href;
        if (a.href !== href) a.href = href;
        if (item.id === c.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
        let button = row.querySelector('.nav-reload');
        if (item.id === c.id && pendingUpdate) {
          if (!button) {
            button = document.createElement('button'); button.type = 'button'; button.className = 'nav-reload';
            button.setAttribute('aria-label', 'Reload updated document'); button.title = 'Document updated — reload';
            button.innerHTML = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 9A7 7 0 0 1 18 6l2 6M4 12l2 6a7 7 0 0 0 12.5-3"/></svg>';
            row.insertBefore(button, row.querySelector('.nav-collapse-toggle'));
          }
          if (flashedVersion !== pendingUpdate.version) {
            flashedVersion = pendingUpdate.version; row.classList.remove('nav-updated-flash'); void row.offsetWidth; row.classList.add('nav-updated-flash');
            clearTimeout(flashTimer); flashTimer = setTimeout(() => row.classList.remove('nav-updated-flash'), 1200);
          }
        } else button?.remove();
        if (item.id === c.id && !item.collapsed) pinnedActive = true;
        const collapsed = Boolean(item.collapsed) && !(item.id === c.id && pinnedActive);
        if (item.version) {
          let toggle = row.querySelector('.nav-collapse-toggle');
          if (!toggle) { toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'nav-collapse-toggle'; row.append(toggle); }
          toggle.dataset.hubId = item.id; toggle.dataset.hubVersion = item.version; toggle.dataset.hubCollapsed = String(collapsed);
          applyCollapseToggle(toggle, item.title, collapsed);
        }
        const target = collapsed ? older : primary, previous = row.parentElement;
        if (previous !== target && next.get(previous) === row) next.set(previous, row.nextElementSibling);
        const before = next.get(target);
        if (row !== before) target.insertBefore(row, before);
        next.set(target, row.nextElementSibling);
      }
      for (const a of existing.values()) { const row = a.parentElement?.classList.contains('nav-row') ? a.parentElement : a; row.remove(); }
      syncOlder();
      if (focused?.isConnected) {
        const closed = focused.closest('details:not([open])');
        if (closed) closed.querySelector('summary')?.focus();
        else if (document.activeElement !== focused) focused.focus();
      }
    } catch {} finally {
      clearTimeout(readTimer); readController = undefined; polling = false;
      const immediate = catchup; catchup = false;
      if (!paused && document.visibilityState !== 'hidden') timer = setTimeout(refresh, immediate ? 0 : 2000);
    }
  }
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer); if (document.visibilityState === 'hidden' || paused) return;
    if (polling) { catchup = true; return; } timer = setTimeout(refresh, 0);
  });
  timer = setTimeout(refresh, 2000);
}

export function siblingSidebarScript(navConfigJson) {
  return `(${siblingSidebarClient.toString()})(${navConfigJson});`;
}

export function renderSiblingNavigation({ destinations, doc, sessionTitle = '', identity, repoName, workspaceName, reviewedScope, confirmNavigation, hubLifecycle, navConfig }) {
  if (!hubLifecycle) throw new Error('hubLifecycle is required');
  const renderItem = item => {
    const label = `${item.collapsed ? 'Restore' : 'Hide'} ${item.title}`;
    const toggle = item.version ? `<button type="button" class="nav-collapse-toggle" data-hub-id="${escapeHtml(item.id)}" data-hub-version="${escapeHtml(item.version)}" data-hub-collapsed="${Boolean(item.collapsed)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="${item.collapsed ? 'M4 14v5h16v-5M12 16V4m-4 4 4-4 4 4' : 'M4 14v5h16v-5M12 4v12m-4-4 4 4 4-4'}"/></svg></button>` : '';
    return `<div class="nav-row"${item.id === doc.id ? ' data-current' : ''}><a href="${escapeHtml(item.href)}" data-hub-id="${escapeHtml(item.id)}"${item.id === doc.id ? ' aria-current="page"' : ''}${item.unseen ? ' title="New publication" aria-describedby="lavish-hub-desc-new" data-unseen="true"' : ''}><span class="nav-label">${escapeHtml(item.title)}</span>${item.unseen ? '<span class="nav-badge nav-badge-new" aria-hidden="true">New</span>' : ''}</a>${toggle}</div>`;
  };
  const older = destinations.filter(item => item.collapsed);
  const items = `<div class="nav-primary">${destinations.filter(item => !item.collapsed).map(renderItem).join('')}</div><details class="nav-older"${older.length ? '' : ' hidden'}${older.some(item => item.id === doc.id) ? ' open' : ''}><summary>Older (<span class="nav-older-count">${older.length}</span>)</summary><div class="nav-older-list">${older.map(renderItem).join('')}</div></details>`;
  return `<style>
html { padding-left: var(--lavish-hub-sidebar-width, 200px); box-sizing: border-box; }
#lavish-hub-sidebar { position: fixed; inset: 0 auto 0 0; width: var(--lavish-hub-sidebar-width, 200px); box-sizing: border-box; z-index: 2147483647; overflow: auto; padding: 16px 10px; background: var(--ob-surface); color: var(--ob-fg); border-right: 1px solid var(--ob-border); font: 14px system-ui, sans-serif; }
#lavish-hub-sidebar .sidebar-header { display: flex; justify-content: flex-end; }
#lavish-hub-sidebar .sidebar-toggle { width: 26px; height: 26px; flex: none; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--ob-fg); font: inherit; cursor: pointer; }
#lavish-hub-sidebar .sidebar-toggle:focus-visible { outline: 2px solid var(--ob-cyan); }
#lavish-hub-sidebar .sidebar-resizer { position: fixed; top: 0; bottom: 0; left: calc(var(--lavish-hub-sidebar-width, 200px) - 5px); width: 5px; cursor: col-resize; touch-action: none; }
#lavish-hub-sidebar .sidebar-resizer:hover, #lavish-hub-sidebar .sidebar-resizer.dragging { background: var(--ob-cyan); }
#lavish-hub-sidebar.is-collapsed { padding: 16px 5px; }
#lavish-hub-sidebar.is-collapsed .hub-identity, #lavish-hub-sidebar.is-collapsed nav, #lavish-hub-sidebar.is-collapsed [role=status], #lavish-hub-sidebar.is-collapsed aside, #lavish-hub-sidebar.is-collapsed .sidebar-resizer { display: none; }
@media (max-width: 650px) {
  html { padding-left: min(var(--lavish-hub-sidebar-width, 200px), 45vw); }
  #lavish-hub-sidebar { width: min(var(--lavish-hub-sidebar-width, 200px), 45vw); }
  #lavish-hub-sidebar .sidebar-resizer { left: calc(min(var(--lavish-hub-sidebar-width, 200px), 45vw) - 5px); }
}
#lavish-hub-sidebar .hub-identity { padding: 0 10px 12px; overflow-wrap: anywhere; }
#lavish-hub-sidebar .hub-session-title { font-weight: 600; color: var(--ob-fg); }
#lavish-hub-sidebar .hub-session-title[hidden] { display: none; }
#lavish-hub-sidebar .hub-repo-name { color: var(--ob-muted); font-size: 12px; }
#lavish-hub-sidebar nav, #lavish-hub-sidebar .nav-primary, #lavish-hub-sidebar .nav-older-list { display: flex; flex-direction: column; gap: 4px; }
#lavish-hub-sidebar details.nav-older { margin: 0; padding: 0; border: 0; background: transparent; color: var(--ob-fg); font: inherit; }
#lavish-hub-sidebar details.nav-older[hidden], #lavish-hub-sidebar details.nav-older:not([open]) .nav-older-list { display: none; }
#lavish-hub-sidebar .nav-older summary { margin: 0; padding: 8px 10px; border: 0; background: transparent; color: var(--ob-muted); font: inherit; cursor: pointer; }
#lavish-hub-sidebar .nav-collapse-toggle { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; margin: 0 4px 0 0; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--ob-muted); font: inherit; cursor: pointer; }
#lavish-hub-sidebar .nav-collapse-toggle:hover, #lavish-hub-sidebar .nav-collapse-toggle:focus-visible { color: var(--ob-fg); outline: 2px solid var(--ob-cyan); }
#lavish-hub-sidebar .nav-collapse-toggle svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
#lavish-hub-sidebar .nav-row { display: flex; align-items: center; gap: 4px; border-radius: 5px; }
#lavish-hub-sidebar .nav-row[data-current] { background: var(--ob-raised); }
#lavish-hub-sidebar nav a { display: flex; flex: 1; min-width: 0; align-items: center; justify-content: space-between; gap: 6px; padding: 8px 10px; border-radius: 5px; color: var(--ob-fg); text-decoration: none; overflow-wrap: anywhere; }
#lavish-hub-sidebar nav a:hover, #lavish-hub-sidebar nav a:focus-visible { background: var(--ob-raised); }
#lavish-hub-sidebar .nav-row[data-current] > a[aria-current] { color: var(--ob-orange); background: transparent; }
#lavish-hub-sidebar .nav-label { min-width: 0; overflow-wrap: anywhere; }
#lavish-hub-sidebar .nav-badge { font-size: 11px; font-weight: 600; line-height: 1.2; padding: 1px 6px; border-radius: 999px; flex: none; white-space: nowrap; }
#lavish-hub-sidebar .nav-badge-new { background: var(--ob-cyan); color: var(--ob-on-accent); }
#lavish-hub-sidebar .nav-reload { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; margin-right: 4px; padding: 0; border: 0; border-radius: 4px; background: var(--ob-green); color: var(--ob-on-accent); cursor: pointer; }
#lavish-hub-sidebar .nav-reload:hover, #lavish-hub-sidebar .nav-reload:focus-visible { outline: 2px solid var(--ob-fg); outline-offset: 1px; }
@keyframes lavish-hub-update-flash { 50% { box-shadow: 0 0 0 2px var(--ob-green); } }
#lavish-hub-sidebar .nav-updated-flash { animation: lavish-hub-update-flash 1s 1; }
@media (prefers-reduced-motion: reduce) { #lavish-hub-sidebar .nav-updated-flash { animation: none; } }
#lavish-hub-sidebar [role=status] { margin: 12px 10px; color: var(--ob-muted); }
#lavish-hub-sidebar [role=status][data-error] { color: var(--ob-red); }
#lavish-hub-sidebar aside { margin: 16px 10px; overflow-wrap: anywhere; color: var(--ob-muted); }
#lavish-hub-toast { position: fixed; right: 12px; bottom: 12px; z-index: 2147483647; display: flex; align-items: center; gap: 8px; max-width: min(28rem, calc(100vw - var(--lavish-hub-sidebar-width, 200px) - 24px)); padding: 10px; border: 1px solid var(--ob-border); border-radius: 6px; background: var(--ob-surface); color: var(--ob-fg); font: 14px system-ui, sans-serif; }
@media (max-width: 650px) { #lavish-hub-toast { max-width: min(28rem, calc(100vw - min(var(--lavish-hub-sidebar-width, 200px), 45vw) - 24px)); } }
#lavish-hub-toast[hidden] { display: none; }
#lavish-hub-toast span { min-width: 0; overflow-wrap: anywhere; }
#lavish-hub-toast button { flex: none; border: 1px solid var(--ob-border); border-radius: 4px; padding: 4px 8px; background: var(--ob-accent, var(--ob-orange)); color: var(--ob-on-accent); font: inherit; cursor: pointer; }
</style><div id="lavish-hub-toast" data-lavish-action role="status" aria-live="polite" hidden></div><div id="lavish-hub-sidebar" data-lavish-action><div class="sidebar-header"><button type="button" class="sidebar-toggle" aria-expanded="true" aria-label="Collapse sidebar" title="Collapse sidebar">«</button></div><div class="sidebar-resizer" aria-hidden="true"></div><span id="lavish-hub-desc-new" hidden>New publication</span><div class="hub-identity"><div class="hub-session-title"${sessionTitle ? '' : ' hidden'}>${escapeHtml(sessionTitle || '')}</div><div class="hub-repo-name">${escapeHtml(identity.session || sessionTitle ? repoName : workspaceName)}</div></div><nav aria-label="Hub navigation">${items}</nav><div role="status" aria-live="polite"></div>${reviewedScope}</div><script>${confirmNavigation}</script><script>${hubLifecycle}</script><script>${siblingSidebarScript(navConfig)}</script>`;
}

// Edit only parser-located tags, leaving authored scripts, doctype and formatting intact.
export function composeHubHtml(authored, sourceUrl, navigation) {
  const document = parse(authored, { sourceCodeLocationInfo: true });
  const html = document.childNodes.find(node => node.tagName === 'html');
  const head = html.childNodes.find(node => node.tagName === 'head');
  const body = html.childNodes.find(node => node.tagName === 'body');
  const bases = [];
  const visit = node => {
    if (node.tagName === 'base' && node.attrs.some(attr => attr.name === 'href')) bases.push(node);
    for (const child of node.childNodes || []) visit(child);
  };
  visit(head);
  const edits = [];
  const defaultTheme = !html.attrs.some(attr => attr.name === 'data-theme') && !html.sourceCodeLocation?.startTag ? '<script>document.documentElement.dataset.theme="orangebox"</script>' : '';
  const theme = `${defaultTheme}<style>${themeCss}\n:where(html[data-theme="orangebox"]) { background: var(--ob-bg); color: var(--ob-fg); }\n:where(html[data-theme="orangebox"] body) { background: var(--ob-bg); color: var(--ob-fg); }</style>`;
  if (!html.attrs.some(attr => attr.name === 'data-theme') && html.sourceCodeLocation?.startTag) {
    const end = html.sourceCodeLocation.startTag.endOffset - 1;
    edits.push([end, end, ' data-theme="orangebox"']);
  }
  const themePosition = head.sourceCodeLocation?.startTag?.endOffset ?? html.sourceCodeLocation?.startTag?.endOffset ?? document.childNodes.find(node => node.nodeName === '#documentType')?.sourceCodeLocation?.endOffset ?? 0;
  edits.push([themePosition, themePosition, head.sourceCodeLocation?.startTag ? theme : `<head>${theme}</head>`]);
  if (bases.length && bases[0].sourceCodeLocation) {
    const base = bases[0];
    const href = base.attrs.find(attr => attr.name === 'href');
    try {
      const relative = sourceUrl.startsWith('/');
      const resolved = new URL(href.value, new URL(sourceUrl, 'http://hub.invalid'));
      href.value = relative && resolved.origin === 'http://hub.invalid' ? `${resolved.pathname}${resolved.search}${resolved.hash}` : resolved.href;
    } catch { href.value = sourceUrl; }
    edits.push([base.sourceCodeLocation.startOffset, base.sourceCodeLocation.endOffset, serializeOuter(base)]);
  } else {
    const base = parseFragment('<base href="">').childNodes[0];
    base.attrs[0].value = sourceUrl;
    const position = head.sourceCodeLocation?.startTag?.endOffset ?? html.sourceCodeLocation?.startTag?.endOffset ?? document.childNodes.find(node => node.nodeName === '#documentType')?.sourceCodeLocation?.endOffset ?? 0;
    edits.push([position, position, `<head>${serializeOuter(base)}</head>`]);
    if (head.sourceCodeLocation?.startTag) edits[edits.length - 1][2] = serializeOuter(base);
  }
  const position = body.sourceCodeLocation?.startTag?.endOffset ?? head.sourceCodeLocation?.endOffset ?? html.sourceCodeLocation?.startTag?.endOffset ?? document.childNodes.find(node => node.nodeName === '#documentType')?.sourceCodeLocation?.endOffset ?? 0;
  edits.push([position, position, navigation]);
  edits.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  for (const [start, end, text] of edits) authored = authored.slice(0, start) + text + authored.slice(end);
  return authored;
}
