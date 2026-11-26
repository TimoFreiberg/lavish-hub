import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/hub-lifecycle.js', import.meta.url), 'utf8');
const sandbox = {}; vm.runInNewContext(source, sandbox);
const { formatTabTitle, applyNavBadge, createLeaveGuard } = sandbox.lavishHubLifecycle;

test('resizable_sidebar_clamping_and_storage_fallback', () => {
  const values = new Map();
  const localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const context = { localStorage };
  vm.runInNewContext(source, context);
  const { createSafeStorage, attachResizablePane } = context.lavishHubLifecycle;
  const storage = createSafeStorage();
  storage.setItem('width', '900');
  const updates = [];
  const options = { storage, widthKey: 'width', collapsedKey: 'collapsed', defaultWidth: 200, minWidth: 160, maxWidth: 420, onChange: state => updates.push({ ...state }) };
  const pane = attachResizablePane(options);
  assert.equal(pane.getState().width, 420);
  pane.setWidth(20); assert.equal(pane.getState().width, 160);
  pane.setCollapsed(true); assert.equal(storage.getItem('collapsed'), 'true');
  pane.setCollapsed(false); assert.equal(storage.getItem('width'), '160');
  assert.equal(updates.at(-1).collapsed, false);
  const handlers = {}, classes = new Set();
  const handle = { addEventListener: (name, fn) => { handlers[name] = fn; }, setPointerCapture: id => { handle.captured = id; }, classList: { add: name => classes.add(name), remove: name => classes.delete(name) } };
  pane.attachResizer(handle, event => event.clientX);
  handlers.pointerdown({ pointerId: 1, button: 0, preventDefault() {} });
  assert.equal(handle.captured, 1); assert.equal(classes.has('dragging'), true);
  handlers.pointermove({ pointerId: 1, clientX: 999 });
  assert.equal(pane.getState().width, 420); assert.equal(storage.getItem('width'), '160');
  handlers.pointerup({ pointerId: 1 });
  assert.equal(storage.getItem('width'), '420'); assert.equal(classes.has('dragging'), false);
  assert.equal(attachResizablePane(options).getState().width, 420);
  Object.defineProperty(context, 'localStorage', { get() { throw new Error('opaque origin'); } });
  const fallback = createSafeStorage();
  fallback.setItem('width', '180'); fallback.setItem('collapsed', 'true');
  const restored = attachResizablePane({ ...options, storage: fallback });
  assert.equal(restored.getState().width, 180); assert.equal(restored.getState().collapsed, true);
  restored.setWidth(300); assert.equal(fallback.getItem('width'), '300');
});

function fixture(withNavigation = false) {
  const listeners = {}, navListeners = {}, timers = new Map();
  let next = 0, dirty = false, now = 0, paused = 0, resumed = 0, statuses = 0, reloads = 0, href = '', confirms = [];
  const env = {
    navigation: withNavigation ? { addEventListener: (name, fn) => { navListeners[name] = fn; } } : undefined,
    addEventListener: (name, fn) => { listeners[name] = fn; },
    setTimeout: (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    location: { replace(value) { href = value; }, reload() { reloads++; } },
    performance: { now: () => now },
    confirmDraftNavigation: async () => confirms.shift(),
  };
  const guard = createLeaveGuard({ env, isDirty: () => dirty, onPause: () => paused++, onResume: () => resumed++, onStatus: () => statuses++ });
  return { env, guard, listeners, navListeners, timers, setDirty: value => { dirty = value; }, setNow: value => { now = value; }, setConfirms: (...values) => { confirms = values; }, get state() { return { paused, resumed, statuses, reloads, href }; }, fireTimer() { const [id, timer] = timers.entries().next().value; timers.delete(id); assert.equal(timer.ms, 1000); timer.fn(); } };
}

test('Older disclosure follows active items and preserves manual choices', () => {
  const controller = sandbox.lavishHubLifecycle.createOlderDisclosureController(), details = { open: false, hidden: false };
  controller.sync(details, { count: 1, activeOlderId: 'one' });
  assert.equal(details.open, true); controller.onUserToggle(details);
  details.open = false; controller.onUserToggle(details);
  controller.sync(details, { count: 1, activeOlderId: 'one' }); assert.equal(details.open, false);
  controller.sync(details, { count: 1, activeOlderId: 'two' }); assert.equal(details.open, true); controller.onUserToggle(details);
  controller.sync(details, { count: 1, activeOlderId: null }); assert.equal(details.open, false); controller.onUserToggle(details);
  details.open = true; controller.onUserToggle(details);
  controller.sync(details, { count: 1, activeOlderId: 'two' });
  controller.sync(details, { count: 1, activeOlderId: null }); assert.equal(details.open, true);
  controller.sync(details, { count: 0, activeOlderId: null }); assert.equal(details.hidden, true);
});

test('tab titles truncate without splitting Unicode code points', () => {
  assert.equal(formatTabTitle('', ''), '');
  assert.equal(formatTabTitle('View', ''), 'View');
  assert.equal(formatTabTitle('', 'Workspace'), 'Workspace');
  assert.equal(formatTabTitle('View', 'Workspace'), 'View · Workspace');
  assert.equal(formatTabTitle('a'.repeat(59) + '😀', 'b'.repeat(119) + '😀'), 'a'.repeat(59) + ' · ' + 'b'.repeat(119));
});

test('badge updates and removes all associated attributes', () => {
  const attrs = {}, el = { dataset: {}, ownerDocument: { createElement: () => ({ setAttribute() {}, remove() { el.badge = null; } }) }, querySelector: () => el.badge, append: node => { el.badge = node; }, setAttribute: (key, value) => { attrs[key] = value; }, removeAttribute: key => { delete attrs[key]; if (key === 'title') delete el.title; } };
  applyNavBadge(el, '', 'desc');
  applyNavBadge(el, 'new', 'desc'); const badge = el.badge;
  assert.equal(badge.textContent, 'New'); assert.equal(el.dataset.unseen, 'true'); assert.equal(attrs['aria-describedby'], 'desc-new');
  applyNavBadge(el, 'new', 'desc'); assert.equal(el.badge, badge);
  applyNavBadge(el, 'attention', 'desc'); assert.equal(el.badge, badge); assert.equal(el.dataset.attention, 'true'); assert.equal(el.dataset.unseen, undefined); assert.equal(attrs['aria-describedby'], 'desc-attention');
  applyNavBadge(el, '', 'desc'); assert.equal(el.badge, null); assert.equal(el.dataset.attention, undefined); assert.equal(attrs['aria-describedby'], undefined); assert.equal(el.title, undefined);
});

test('leave and reload fall back only without Navigation API', () => {
  for (const withNavigation of [false, true]) {
    for (const method of ['leave', 'reload']) {
      const f = fixture(withNavigation); f.guard[method]('next');
      assert.equal(f.guard.isLeaving(), true); assert.equal(f.state.paused, 1);
      assert.equal(f.state.href, method === 'leave' ? 'next' : ''); assert.equal(f.state.reloads, method === 'reload' ? 1 : 0);
      assert.equal(f.timers.size, withNavigation ? 0 : 1);
      if (!withNavigation) { f.fireTimer(); assert.equal(f.guard.isLeaving(), false); assert.equal(f.guard.isUncertain(), true); assert.equal(f.state.resumed, 1); f.guard.clearUncertain(); assert.equal(f.guard.isUncertain(), false); }
      else { f.guard.resume(); assert.equal(f.guard.isLeaving(), false); assert.equal(f.state.resumed, 1); }
    }
  }
});

test('framed navigation arms fallback even with Navigation API', () => {
  const f = fixture(true); const calls = [];
  f.env.self = {}; f.env.top = {};
  f.env.lavish = { navigateFrame: url => calls.push(url) };
  f.guard.leave('next');
  assert.deepEqual(calls, ['next']); assert.equal(f.state.href, '');
  assert.equal(f.timers.size, 1); f.fireTimer();
  assert.equal(f.guard.isUncertain(), true); assert.equal(f.guard.isLeaving(), false);
});

test('new navigation and BFCache restore clear earlier cancellation', () => {
  const f = fixture(true);
  const abort = () => {
    const controller = new AbortController();
    f.navListeners.navigate({ signal: controller.signal }); controller.abort();
    assert.equal(f.guard.isCancelled(), true);
  };
  f.guard.leave('first'); abort();
  f.guard.reload(); assert.equal(f.guard.isCancelled(), false);
  abort(); f.listeners.pageshow({ persisted: false }); assert.equal(f.guard.isCancelled(), true);
  f.listeners.pageshow({ persisted: true }); assert.equal(f.guard.isCancelled(), false);
});

test('abort, BFCache and beforeunload update guard state', () => {
  const f = fixture(true); let prevented = 0;
  const unload = () => f.listeners.beforeunload({ preventDefault() { prevented++; }, returnValue: null });
  unload(); f.setDirty(true); unload(); assert.equal(prevented, 1);
  f.guard.leave('next'); unload(); assert.equal(prevented, 1);
  const signal = new AbortController(); f.navListeners.navigate({ signal: signal.signal }); signal.abort();
  assert.equal(f.guard.isCancelled(), true); assert.equal(f.guard.isLeaving(), false); assert.equal(f.state.resumed, 1);
  f.guard.clearCancelled(); assert.equal(f.guard.isCancelled(), false);
  f.guard.reload(); f.listeners.pageshow({ persisted: false }); assert.equal(f.guard.isLeaving(), true);
  f.listeners.pageshow({ persisted: true }); assert.equal(f.guard.isLeaving(), false); assert.equal(f.guard.isUncertain(), false); assert.equal(f.state.resumed, 2);
  const g = fixture(); g.guard.leave('next'); g.fireTimer(); g.listeners.pageshow({ persisted: true }); assert.equal(g.guard.isUncertain(), false);
});

test('confirm twice guards dirty drafts before and after an async action', async () => {
  const f = fixture(); let revision = 0, acts = 0;
  const run = act => f.guard.confirmTwice('leave', () => revision, act || (async () => { acts++; }));
  assert.equal(await run(), true); assert.equal(acts, 1);
  f.setDirty(true); f.setConfirms(false); assert.equal(await run(), false); assert.equal(acts, 1);
  f.setConfirms(true); assert.equal(await run(), true); assert.equal(acts, 2);
  f.setConfirms(true, false); assert.equal(await run(async () => { revision++; }), false);
  f.setConfirms(true, true); assert.equal(await run(async () => { revision++; }), true);
  f.setDirty(false); f.setConfirms(false); assert.equal(await run(async () => { revision++; f.setDirty(true); }), false);
  f.setConfirms(true); assert.equal(await run(async () => false), false);
});

test('confirmation refreshes dirty state after an action even without recorded edits', async () => {
  const f = fixture(); let checks = 0;
  const guard = createLeaveGuard({ env: f.env, isDirty: () => { checks++; return true; }, onPause() {}, onResume() {}, onStatus() {} });
  f.setConfirms(true);
  assert.equal(await guard.confirmTwice('leave', () => 0, async () => {}), true);
  assert.equal(checks, 2);
});

test('unauthorized reload requires a clean, idle page older than ten seconds', () => {
  const f = fixture(); const response = { status: 403 }, data = { error: 'Unauthorized' };
  f.setNow(10000); f.guard.handleUnauthorized(response, data); assert.equal(f.state.reloads, 0);
  f.setNow(10001); f.setDirty(true); f.guard.handleUnauthorized(response, data); assert.equal(f.state.reloads, 0);
  f.setDirty(false); f.guard.handleUnauthorized({ status: 500 }, data); f.guard.handleUnauthorized(response, { error: 'Other' }); assert.equal(f.state.reloads, 0);
  f.guard.handleUnauthorized(response, data); assert.equal(f.state.reloads, 1); assert.equal(f.state.paused, 1); assert.equal(f.guard.isLeaving(), true); assert.equal(f.timers.size, 0);
  f.guard.handleUnauthorized(response, data); assert.equal(f.state.reloads, 1);
});
