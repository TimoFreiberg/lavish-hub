globalThis.lavishHubLifecycle = {
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
