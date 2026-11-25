import test, { before, after, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { siblingSidebarScript, renderSiblingNavigation } from '../src/hub-html.mjs';
import { themeCss } from '../src/orangebox.mjs';
import { inspectGeometry, scanDocument } from '../scripts/visual/checks.mjs';

function shippedSidebarScript(extraConfig = {}) {
  return siblingSidebarScript(JSON.stringify({ url: 'http://lavish.test/hub-proxy/test', capability: 'c'.repeat(64), id: 'doc', ...extraConfig }));
}

async function eventually(check, timeout) {
  const deadline = Date.now() + timeout;
  while (true) {
    try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 25)); }
  }
}

async function sidebarPage(browser, { hidden = false, identity = false } = {}) {
  const page = await browser.newPage();
  // A real origin keeps the sidebar's relative hrefs resolvable.
  await page.route('http://lavish.test/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>blank</title>' }));
  await page.goto('http://lavish.test/published.html');
  const script = shippedSidebarScript(identity ? { title: 'Document', repoName: 'repo', sessionTitle: 'Original' } : {});
  const header = identity ? '<div class="hub-identity"><div class="hub-session-title">Original</div><div class="hub-repo-name">repo</div></div>' : '';
  const sidebar = `<div id="lavish-hub-sidebar" data-lavish-action>${header}<nav aria-label="Hub navigation"><a href="hub.html" data-hub-id="doc">Document</a></nav><div role="status" aria-live="polite"></div></div>`;
  // The stub counts status polls, parks one while __hold is set, answers with an
  // error while __fail is set, and never answers while __hang is set. The page
  // itself never leaves the document view. Like a real fetch, a parked or hung
  // request rejects when its signal aborts.
  const stub = `<script>globalThis.__hidden = ${hidden}; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => globalThis.__hidden ? 'hidden' : 'visible' }); globalThis.confirmDraftNavigation = async () => true; globalThis.__status = 0; globalThis.__title = ${identity ? "'Original'" : "undefined"}; globalThis.lavish = { setDocumentMeta: value => { globalThis.__metaTitle = value.title; } }; globalThis.__hold = false; globalThis.__hang = false; globalThis.__fail = false; globalThis.__failNavigate = false; globalThis.__aborted = 0; globalThis.__parked = []; globalThis.__release = () => { globalThis.__hold = false; for (const resolve of globalThis.__parked.splice(0)) resolve(); }; const aborted = signal => new Promise((resolve, reject) => { const rejectAborted = () => { globalThis.__aborted++; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }; if (signal?.aborted) return rejectAborted(); signal?.addEventListener('abort', rejectAborted, { once: true }); }); globalThis.fetch = async (_url, options) => { const { operation } = JSON.parse(options.body); if (operation === 'navigate' && globalThis.__failNavigate) return { ok: false, status: 500, json: async () => ({}) }; if (operation === 'navigate' && globalThis.__hangNavigate) { globalThis.__hangNavigate = false; await aborted(options.signal); } if (operation === 'status') { globalThis.__status++; if (globalThis.__fail) { globalThis.__fail = false; return { ok: false, status: 500, json: async () => ({}) }; } if (globalThis.__hold) await new Promise(resolve => globalThis.__parked.push(resolve)); if (globalThis.__hang) await aborted(options.signal); } const result = operation === 'status' ? { available: true, selected: 'doc', title: globalThis.__title } : operation === 'documents' ? { documents: [{ id: 'doc', title: 'Document', source: 'doc.md' }] } : {}; return { ok: true, json: async () => ({ result }) }; };</script>`;
  await page.setContent(`${sidebar}${stub}<script>${script}</script>`);
  return page;
}

const statusCalls = page => page.evaluate(() => globalThis.__status);
const setHidden = (page, hidden) => page.evaluate(value => { globalThis.__hidden = value; document.dispatchEvent(new Event('visibilitychange')); }, hidden);
let browser;
before(async () => { browser = await chromium.launch({ executablePath: process.env.LAVISH_HUB_CHROMIUM || chromium.executablePath(), headless: true }); });
afterEach(async () => { await Promise.all(browser.contexts().map(context => context.close())); });
after(async () => { await browser.close(); });

async function updatePage(browser, controls = '<label>Draft <input id="draft" value="initial"></label>', { noNavigationApi = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.route('http://lavish.test/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Reloaded</title>' }));
  await page.goto('http://lavish.test/published.html');
  const config = JSON.stringify({ url: 'http://lavish.test/hub-proxy/test', capability: 'c'.repeat(64), id: 'doc', version: 'v1', title: 'Document', workspaceName: 'workspace' });
  const navigation = renderSiblingNavigation({ destinations: [{ id: 'doc', title: 'Document', href: 'published.html' }], doc: { id: 'doc' }, currentTarget: {}, identity: {}, repoName: 'repo', workspaceName: 'workspace', reviewedScope: '', confirmNavigation: 'globalThis.confirmDraftNavigation = async () => true;', navConfig: config });
  const stub = `<script>${noNavigationApi ? "Object.defineProperty(window, 'navigation', { value: undefined });" : ''}globalThis.__doc={id:'doc',title:'Document',source:'doc.html',sibling:'published.html',version:'v1'};globalThis.__selected='doc';globalThis.fetch=async (_url,options)=>({ok:true,json:async()=>({result:JSON.parse(options.body).operation==='status'?{selected:globalThis.__selected}:JSON.parse(options.body).operation==='documents'?{documents:[globalThis.__doc]}:{}})});</script>`;
  await page.setContent(`<!doctype html><html lang="en" data-theme="orangebox"><head><title>Document</title><style>${themeCss}</style></head><body>${stub}${navigation}<main>${controls}</main></body></html>`);
  return page;
}
const advance = (page, update = {}) => page.evaluate(update => { Object.assign(globalThis.__doc, { version: 'v2', ...update }); document.dispatchEvent(new Event('visibilitychange')); }, update);

test('published HTML sidebar auto-reloads when clean and version advances', { timeout: 30000 }, async t => {
  const page = await updatePage(browser);
  const navigation = page.waitForEvent('framenavigated'); await advance(page); await navigation;
  assert.equal(page.url(), 'http://lavish.test/published.html'); assert.equal(await page.title(), 'Reloaded');
});

test('published HTML sidebar navigates when republished sibling path or type changes', { timeout: 30000 }, async t => {
  for (const [update, destination] of [[{ sibling: 'replacement.html' }, 'replacement.html'], [{ source: 'doc.md' }, 'hub.html']]) {
    const page = await updatePage(browser); const navigation = page.waitForEvent('framenavigated'); await advance(page, update); await navigation;
    assert.equal(page.url(), 'http://lavish.test/' + destination); await page.close();
  }
});

test('published HTML sidebar shows flashing green reload button instead of reloading when dirty', { timeout: 30000 }, async t => {
  const page = await updatePage(browser); await page.locator('#draft').fill('unsaved'); await advance(page);
  const button = page.getByRole('button', { name: 'Reload updated document' }); await button.waitFor();
  assert.equal(await page.locator('#draft').inputValue(), 'unsaved');
  assert.equal(await page.locator('.nav-row[data-current] > a + button.nav-reload').count(), 1);
  assert.equal(await page.locator('a .nav-reload, a[aria-current] .nav-badge-new').count(), 0);
  const row = page.locator('.nav-row[data-current]');
  assert.equal(await row.evaluate(el => el.classList.contains('nav-updated-flash')), true);
  await page.waitForFunction(() => !document.querySelector('.nav-row[data-current]').classList.contains('nav-updated-flash'));
  await advance(page, { version: 'v3' });
  await page.waitForFunction(() => document.querySelector('.nav-row[data-current]').classList.contains('nav-updated-flash'));
  const result = await scanDocument(page); const geometry = await page.evaluate(inspectGeometry);
  assert.deepEqual(result.accessibility, []); assert.equal(geometry.horizontalOverflow, false);
  assert.deepEqual(geometry.clippedText, []); assert.deepEqual(geometry.narrowText, []); assert.deepEqual(geometry.controls, []);
  assert.equal(await button.evaluate(el => { const probe = document.createElement('span'); probe.style.color = 'var(--ob-green)'; el.append(probe); const matches = getComputedStyle(el).backgroundColor === getComputedStyle(probe).color; probe.remove(); return matches; }), true);
  await page.evaluate(() => { globalThis.confirmDraftNavigation = () => { throw new Error('unexpected confirmation'); }; });
  const navigation = page.waitForEvent('framenavigated'); await button.click(); await navigation;
  assert.equal(await page.title(), 'Reloaded');
});

test('published HTML sidebar triggers deferred reload when authored edits return to clean state', { timeout: 60000 }, async t => {
  const choosePlain = async (page, key) => {
    await page.locator('#control').evaluate(el => { el.size = 2; });
    await page.locator('#control').focus(); await page.keyboard.press(key);
    await page.locator('#control').evaluate(el => el.removeAttribute('size'));
  };
  const cases = [
    ['<input id="control" aria-label="control" value="initial">', async p => p.locator('#control').fill('changed'), async p => p.locator('#control').fill('initial')],
    ['<textarea id="control" aria-label="control">initial</textarea>', async p => p.locator('#control').fill('changed'), async p => p.locator('#control').fill('initial')],
    ['<select id="control" aria-label="control" size="2"><option selected value="a">A</option><option value="b">B</option></select>', async p => { await p.locator('#control').focus(); await p.keyboard.press('ArrowDown'); }, async p => { await p.locator('#control').focus(); await p.keyboard.press('ArrowUp'); }],
    ['<select id="control" aria-label="control"><option value="a">A</option><option value="b">B</option></select>', async p => choosePlain(p, 'ArrowDown'), async p => choosePlain(p, 'ArrowUp')],
    ['<form><select id="control" aria-label="control"><option value="a">A</option><option value="b">B</option></select><button type="reset">Reset</button></form>', async p => choosePlain(p, 'ArrowDown'), async p => p.getByRole('button', { name: 'Reset' }).click()],
    ['<input id="control" type="checkbox" aria-label="control">', async p => p.locator('#control').click(), async p => p.locator('#control').click()],
    ['<input id="a" type="radio" name="a[0]" checked aria-label="A"><input id="b" type="radio" name="a[0]" aria-label="B">', async p => p.locator('#b').click(), async p => p.locator('#a').click()],
    ['<form id="f"><input id="a" type="radio" name="group" checked aria-label="A"></form><input id="b" type="radio" name="group" form="f" aria-label="B">', async p => p.locator('#b').click(), async p => p.locator('#a').click()],
    ['<div id="control" contenteditable="true">initial</div>', async p => p.locator('#control').fill('changed'), async p => p.locator('#control').fill('initial')],
    ['<form><input id="control" aria-label="control" value="initial"><button type="reset">Reset</button></form>', async p => p.locator('#control').fill('changed'), async p => p.getByRole('button', { name: 'Reset' }).click()],
  ];
  for (const [controls, edit, revert] of cases) {
    const page = await updatePage(browser, controls); await edit(page);
    if (controls.startsWith('<select id="control"') && !controls.includes('size=')) assert.equal(await page.locator('#control').inputValue(), 'b');
    await advance(page);
    try { await page.getByRole('button', { name: 'Reload updated document' }).waitFor({ timeout: 4000 }); }
    catch (error) { throw new Error(`No pending update for ${controls}`, { cause: error }); }
    const navigation = page.waitForEvent('framenavigated'); await revert(page); await navigation;
    assert.equal(await page.title(), 'Reloaded'); await page.close();
  }
});

test('published HTML sidebar tracks formatting and removed controls', { timeout: 30000 }, async () => {
  const page = await updatePage(browser, '<div id="editable" contenteditable="true">initial</div>');
  await page.locator('#editable').focus(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('ControlOrMeta+B');
  assert.equal(await page.locator('#editable').textContent(), 'initial');
  assert.notEqual(await page.locator('#editable').innerHTML(), 'initial');
  await advance(page); await page.getByRole('button', { name: 'Reload updated document' }).waitFor();
  assert.equal(await page.title(), 'Document · workspace');
  await page.evaluate(() => document.querySelector('#editable').remove());
  const navigation = page.waitForEvent('framenavigated');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await navigation;
  assert.equal(await page.title(), 'Reloaded');
});

describe('published HTML sidebar navigation guards and update behavior', () => {
test('published HTML sidebar gives remote selection precedence and respects error guards', { timeout: 30000 }, async t => {
  const page = await updatePage(browser);
  await page.evaluate(() => { document.querySelector('[role=status]').dataset.error = ''; });
  await advance(page); await page.getByRole('button', { name: 'Reload updated document' }).waitFor();
  assert.equal(await page.title(), 'Document · workspace');
  await page.evaluate(() => { delete document.querySelector('[role=status]').dataset.error; globalThis.__selected = 'tasks'; });
  const navigation = page.waitForEvent('framenavigated'); await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await navigation;
  assert.equal(page.url(), 'http://lavish.test/hub.html');
});

test('published HTML sidebar keeps pending edits during remote selection and yields when clean', { timeout: 30000 }, async t => {
  const page = await updatePage(browser); await page.locator('#draft').fill('unsaved');
  await page.evaluate(() => { globalThis.__selected = 'tasks'; document.dispatchEvent(new Event('visibilitychange')); });
  await page.getByRole('link', { name: 'Tasks' }).waitFor();
  assert.equal(await page.locator('#draft').inputValue(), 'unsaved');
  await page.locator('#draft').fill('initial');
  assert.equal(await page.title(), 'Document · workspace');
  const navigation = page.waitForEvent('framenavigated');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await navigation;
  assert.equal(page.url(), 'http://lavish.test/hub.html');
});

test('published HTML sidebar defers reload while navigation is in flight or failed', { timeout: 30000 }, async t => {
  const page = await updatePage(browser); await page.locator('#draft').fill('unsaved'); await advance(page);
  await page.getByRole('button', { name: 'Reload updated document' }).waitFor();
  await page.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (JSON.parse(options.body).operation !== 'navigate') return original(url, options);
      await new Promise(resolve => { globalThis.__finishNavigation = resolve; });
      return { ok: false, status: 500, json: async () => ({}) };
    };
  });
  await page.getByRole('link', { name: 'Document' }).click();
  await page.waitForFunction(() => typeof globalThis.__finishNavigation === 'function');
  await page.locator('#draft').fill('initial');
  assert.equal(await page.title(), 'Document · workspace');
  await page.evaluate(() => globalThis.__finishNavigation());
  await page.getByText('Could not open Document. Select it again to retry.').waitFor();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(200); assert.equal(await page.title(), 'Document · workspace');
});

test('published HTML sidebar guards updates when navigation may still be in progress', { timeout: 30000 }, async () => {
  const page = await updatePage(browser, undefined, { noNavigationApi: true });
  await page.route('http://lavish.test/hub.html', route => route.abort('aborted'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.getByRole('link', { name: 'Tasks' }).click();
  await page.getByText('Navigation may still be in progress; select a destination to continue').waitFor();
  await advance(page); await page.getByRole('button', { name: 'Reload updated document' }).waitFor();
  assert.equal(await page.title(), 'Document · workspace');
  await page.locator('#draft').fill('unsaved'); await page.locator('#draft').fill('initial');
  await page.waitForTimeout(300); assert.equal(await page.title(), 'Document · workspace');
  await advance(page, { version: 'v3' });
  await page.waitForTimeout(300); assert.equal(await page.title(), 'Document · workspace');
});

test('published HTML sidebar waits for recent Lavish input before auto-reload', { timeout: 30000 }, async () => {
  const page = await updatePage(browser, '<div data-lavish-ui><input id="note"></div>');
  await page.locator('#note').fill('annotation');
  const navigation = page.waitForEvent('framenavigated'); await advance(page);
  await page.getByRole('button', { name: 'Reload updated document' }).waitFor();
  assert.equal(await page.title(), 'Document · workspace');
  await navigation; assert.equal(await page.title(), 'Reloaded');
});

test('published HTML sidebar ignores Lavish controls and honors reduced motion', { timeout: 30000 }, async t => {
  const page = await updatePage(browser, '<div data-lavish-ui><label>Note <input id="note"></label></div><label>Draft <input id="draft" value="initial"></label>');
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.locator('#note').fill('annotation');
  await page.locator('#draft').fill('unsaved'); await advance(page);
  const button = page.getByRole('button', { name: 'Reload updated document' }); await button.waitFor();
  assert.equal(await page.locator('.nav-row[data-current]').evaluate(el => getComputedStyle(el).animationName), 'none');
  const navigation = page.waitForEvent('framenavigated'); await page.locator('#draft').fill('initial'); await navigation;
  assert.equal(await page.title(), 'Reloaded');
});

});

test('published HTML sidebar updates session title and tab title on status poll', { timeout: 30000 }, async t => {
  const page = await sidebarPage(browser, { identity: true });
  assert.equal(await page.locator('.hub-repo-name').textContent(), 'repo');
  assert.equal(await page.locator('.hub-session-title').textContent(), 'Original');
  assert.equal(await page.title(), 'Document · Original');
  await page.evaluate(() => { globalThis.__title = 'Updated'; });
  await page.waitForFunction(() => document.querySelector('.hub-session-title').textContent === 'Updated');
  assert.equal(await page.title(), 'Document · Updated');
  assert.equal(await page.evaluate(() => globalThis.__metaTitle), 'Document · Updated');
  await page.evaluate(() => { globalThis.__title = ''; });
  await page.waitForFunction(() => document.title === 'Document · repo');
  assert.equal(await page.locator('.hub-session-title').isVisible(), false);
});

test('published page sidebar stops polling while the tab is hidden', { timeout: 30000 }, async t => {
  const page = await sidebarPage(browser);
  await eventually(async () => assert.ok(await statusCalls(page) >= 1), 5000);
  await setHidden(page, true);
  const hidden = await statusCalls(page);
  await page.waitForTimeout(2500);
  assert.equal(await statusCalls(page), hidden);
  await setHidden(page, false);
  // Catch-up runs at once instead of on the next two-second tick.
  await eventually(async () => assert.ok(await statusCalls(page) > hidden), 1200);
  assert.equal(await page.getByRole('link', { name: 'Document' }).getAttribute('aria-current'), 'page');
});

test('published page sidebar catches up at once when a poll is in flight', { timeout: 30000 }, async t => {
  const page = await sidebarPage(browser);
  await eventually(async () => assert.ok(await statusCalls(page) >= 1), 5000);
  await page.evaluate(() => { globalThis.__hold = true; });
  // The next poll parks in flight, so visibility returns mid-poll.
  await eventually(async () => assert.ok(await statusCalls(page) >= 2), 4000);
  await setHidden(page, true);
  await setHidden(page, false);
  await page.evaluate(() => globalThis.__release());
  // The catch-up follows the parked poll straight away instead of the next tick.
  await eventually(async () => assert.ok(await statusCalls(page) >= 3), 900);
});

test('published page sidebar recovers when a status poll never answers', { timeout: 30000 }, async t => {
  const page = await sidebarPage(browser);
  await eventually(async () => assert.ok(await statusCalls(page) >= 1), 5000);
  await page.evaluate(() => { globalThis.__hang = true; });
  await eventually(async () => assert.ok(await statusCalls(page) >= 2), 4000);
  const hung = await statusCalls(page);
  // The bounded read gives up on its own, so the sidebar asks again instead of
  // staying busy for as long as the request goes unanswered.
  await eventually(async () => assert.ok(await statusCalls(page) >= hung + 1), 20000);
  assert.ok(await page.evaluate(() => globalThis.__aborted) >= 1);
  assert.equal(await page.getByRole('link', { name: 'Document' }).getAttribute('aria-current'), 'page');
});

test('published page sidebar abandons an obsolete read poll when navigation pauses it', { timeout: 30000 }, async t => {
  const page = await sidebarPage(browser);
  await eventually(async () => assert.ok(await statusCalls(page) >= 1), 5000);
  // A failed navigation action keeps the page in place while still pausing it.
  await page.evaluate(() => { globalThis.__hang = true; globalThis.__failNavigate = true; });
  await eventually(async () => assert.ok(await statusCalls(page) >= 2), 4000);
  const hung = await statusCalls(page);
  assert.equal(await page.evaluate(() => globalThis.__aborted), 0);
  await page.getByRole('link', { name: 'Document' }).click();
  // The pause cancels the read whose answer the page would discard anyway.
  await eventually(async () => assert.equal(await page.evaluate(() => globalThis.__aborted), 1), 4000);
  await page.getByText('Could not open Document. Select it again to retry.').waitFor();
  // The cancelled read released the poll, so the resumed sidebar asks again.
  await eventually(async () => assert.ok(await statusCalls(page) > hung), 6000);
});

test('published page sidebar gives up on a navigation that is never answered', { timeout: 30000 }, async t => {
  const page = await sidebarPage(browser);
  await eventually(async () => assert.ok(await statusCalls(page) >= 1), 5000);
  await page.evaluate(() => { globalThis.__hangNavigate = true; });
  await page.getByRole('link', { name: 'Document' }).click();
  // Without its own bound the sidebar would stay busy, and ignore every later
  // selection, for as long as the lost request goes unanswered.
  await page.getByText('Could not open Document. Select it again to retry.').waitFor({ timeout: 20000 });
  assert.equal(await page.evaluate(() => globalThis.__aborted), 1);
  assert.equal(await page.locator('nav').getAttribute('aria-busy'), null);
});

test('published page sidebar reloads when a restarted owner rejects its access token', { timeout: 30000 }, async t => {
  const page = await sidebarPage(browser);
  await eventually(async () => assert.ok(await statusCalls(page) >= 1), 5000);
  await page.evaluate(() => { const real = globalThis.fetch; globalThis.fetch = async (url, options) => JSON.parse(options.body).operation === 'status' ? { ok: false, status: 403, json: async () => ({ error: 'Unauthorized' }) } : real(url, options); });
  await page.waitForEvent('framenavigated', { timeout: 20000 });
});

test('published page sidebar keeps polling after a failed read', { timeout: 30000 }, async t => {
  const page = await sidebarPage(browser);
  await eventually(async () => assert.ok(await statusCalls(page) >= 1), 5000);
  const before = await page.evaluate(() => { globalThis.__fail = true; return globalThis.__status; });
  await eventually(async () => assert.ok(await statusCalls(page) >= before + 2), 6000);
  assert.equal(await page.getByRole('link', { name: 'Document' }).getAttribute('aria-current'), 'page');
});

test('published page sidebar warms once while the tab starts hidden', { timeout: 30000 }, async t => {
  const page = await sidebarPage(browser, { hidden: true });
  // The first poll runs anyway, so the sidebar is populated when the page is shown.
  await eventually(async () => assert.ok(await statusCalls(page) >= 1), 5000);
  await page.waitForTimeout(2500);
  assert.equal(await statusCalls(page), 1);
  assert.equal(await page.getByRole('link', { name: 'Document' }).getAttribute('aria-current'), 'page');
});
