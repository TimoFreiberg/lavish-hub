globalThis.lavishHubLifecycle = {
  createSafeStorage() {
    const fallback = new Map(), failed = new Set();
    return {
      getItem(key) {
        if (failed.has(key)) return fallback.get(key) ?? null;
        try { return globalThis.localStorage.getItem(key); } catch { return fallback.get(key) ?? null; }
      },
      setItem(key, value) {
        value = String(value); fallback.set(key, value);
        try { globalThis.localStorage.setItem(key, value); failed.delete(key); } catch { failed.add(key); }
      },
    };
  },
  attachResizablePane({ storage, widthKey, collapsedKey, defaultWidth, minWidth, maxWidth, onChange }) {
    const savedWidth = storage.getItem(widthKey);
    const clamp = value => Math.max(minWidth, Math.min(maxWidth, value));
    let width = clamp(savedWidth !== null && savedWidth.trim() !== '' && Number.isFinite(Number(savedWidth)) ? Number(savedWidth) : defaultWidth);
    let collapsed = storage.getItem(collapsedKey) === 'true';
    const getState = () => ({ width, collapsed });
    const notify = () => onChange?.(getState());
    const persist = () => { storage.setItem(widthKey, width); storage.setItem(collapsedKey, collapsed); };
    const setWidth = (value, save = true) => {
      if (!Number.isFinite(Number(value))) return;
      width = clamp(Number(value)); notify(); if (save) persist();
    };
    const setCollapsed = value => { collapsed = Boolean(value); notify(); persist(); };
    function attachResizer(handleEl, measureWidth) {
      let pointerId = null;
      handleEl.addEventListener('pointerdown', event => {
        if (collapsed || pointerId !== null || event.button !== 0) return;
        pointerId = event.pointerId; handleEl.setPointerCapture(pointerId); handleEl.classList.add('dragging'); event.preventDefault();
      });
      handleEl.addEventListener('pointermove', event => { if (event.pointerId === pointerId) setWidth(measureWidth(event), false); });
      const finish = event => {
        if (event.pointerId !== pointerId) return;
        pointerId = null; handleEl.classList.remove('dragging'); persist();
      };
      handleEl.addEventListener('pointerup', finish);
      handleEl.addEventListener('pointercancel', finish);
      handleEl.addEventListener('lostpointercapture', finish);
    }
    return { getState, setCollapsed, setWidth, attachResizer };
  },
  formatTabTitle(view, workspace) {
    const cut = (text, limit) => { let out = ''; for (const ch of text || '') { if (out.length + ch.length > limit) break; out += ch; } return out; };
    const name = cut(view, 60), suffix = cut(workspace, 120);
    return name && suffix ? `${name} · ${suffix}` : name || suffix;
  },
  applyNavBadge(el, kind, descPrefix) {
    let badge = el.querySelector('.nav-badge');
    if (kind === 'new' || kind === 'attention') {
      if (!badge) { badge = el.ownerDocument.createElement('span'); badge.setAttribute('aria-hidden', 'true'); el.append(badge); }
      badge.className = `nav-badge nav-badge-${kind}`;
      badge.textContent = kind === 'new' ? 'New' : 'Attention';
      el.title = kind === 'new' ? 'New publication' : 'Needs attention';
      el.setAttribute('aria-describedby', `${descPrefix}-${kind}`);
      if (kind === 'new') el.dataset.unseen = 'true'; else delete el.dataset.unseen;
      if (kind === 'attention') el.dataset.attention = 'true'; else delete el.dataset.attention;
    } else {
      badge?.remove(); el.removeAttribute('title'); el.removeAttribute('aria-describedby');
      delete el.dataset.unseen; delete el.dataset.attention;
    }
  },
  applyCollapseToggle(button, title, collapsed) {
    const label = `${collapsed ? 'Restore' : 'Hide'} ${title}`;
    if (button.getAttribute('aria-label') === label && button.title === label && button.querySelector('svg')) return;
    button.setAttribute('aria-label', label); button.title = label;
    button.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="${collapsed ? 'M4 14v5h16v-5M12 16V4m-4 4 4-4 4 4' : 'M4 14v5h16v-5M12 4v12m-4-4 4 4 4-4'}"/></svg>`;
  },
  createOlderDisclosureController({ initialOpen = false } = {}) {
    let manualOpen = null, lastActiveOlderId = null, pendingOpen = initialOpen ? true : null;
    return {
      sync(details, { count, activeOlderId }) {
        details.hidden = count === 0;
        if (activeOlderId && activeOlderId !== lastActiveOlderId && !details.open) { pendingOpen = true; details.open = true; }
        else if (!activeOlderId && lastActiveOlderId && manualOpen !== true && details.open) { pendingOpen = false; details.open = false; }
        lastActiveOlderId = activeOlderId || null;
      },
      onUserToggle(details) {
        if (pendingOpen !== null && details.open === pendingOpen) { pendingOpen = null; return; }
        pendingOpen = null; manualOpen = details.open;
      },
    };
  },
  createLeaveGuard({ isDirty, onPause, onResume, onStatus, env = globalThis }) {
    let leaving = false, uncertain = false, cancelled = false, timer;
    function resume() { env.clearTimeout(timer); leaving = false; onResume(); }
    function begin(forceFallback = false) {
      cancelled = false; onPause(); leaving = true;
      if (!env.navigation || forceFallback) timer = env.setTimeout(() => { uncertain = true; onStatus(); resume(); }, 1000);
    }
    env.navigation?.addEventListener('navigate', event => {
      if (leaving) event.signal.addEventListener('abort', () => { uncertain = false; cancelled = true; onStatus(); resume(); }, { once: true });
    });
    env.addEventListener('pageshow', event => { if (event.persisted) { uncertain = false; cancelled = false; onStatus(); resume(); } });
    env.addEventListener('beforeunload', event => { if (isDirty() && !leaving) { event.preventDefault(); event.returnValue = ''; } });
    return {
      isLeaving: () => leaving,
      isUncertain: () => uncertain,
      isCancelled: () => cancelled,
      clearCancelled: () => { cancelled = false; },
      clearUncertain: () => { uncertain = false; },
      leave(url) {
        const useNavigateFrame = Boolean(env.lavish?.navigateFrame && env.self !== env.top);
        begin(useNavigateFrame);
        if (useNavigateFrame) env.lavish.navigateFrame(url);
        else env.location.replace(url);
      },
      reload() { begin(); env.location.reload(); },
      resume,
      async confirmTwice(message, getEdits, act) {
        let approved = false, revision = getEdits();
        if (isDirty()) { approved = await env.confirmDraftNavigation(message); if (!approved) return false; }
        if (await act() === false) return false;
        const dirty = isDirty();
        if ((!approved || revision !== getEdits()) && dirty && !(await env.confirmDraftNavigation(message))) return false;
        return true;
      },
      handleUnauthorized(response, data) {
        if (response.status === 403 && data.error === 'Unauthorized' && env.performance.now() > 1e4 && !isDirty() && !leaving) {
          leaving = true; onPause(); env.location.reload();
        }
      },
    };
  },
};
