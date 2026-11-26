export const hubDashboard = `<!doctype html>
<html lang="en" data-theme="orangebox">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Active hubs · Lavish</title>
<style>
:root {
  color-scheme: dark;
  --ob-bg: #262120; --ob-surface: #1e1a18; --ob-raised: #312b28; --ob-border: #463c36;
  --ob-fg: #ebe1cd; --ob-muted: #a89a86; --ob-orange: #f3a762;
  --ob-cyan: #a8c6c6; --ob-on-accent: #1e1a18;
  --unread-accent: var(--ob-cyan);
  --unread-border: color-mix(in srgb, var(--ob-cyan) 38%, var(--ob-border));
  --unread-bg: color-mix(in srgb, var(--ob-cyan) 7%, var(--ob-surface));
  --group-border: color-mix(in srgb, var(--ob-border) 70%, transparent);
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--ob-bg); color: var(--ob-fg); font: 15px/1.5 system-ui, -apple-system, sans-serif; }
main { max-width: 58rem; margin: 0 auto; padding: 2rem 1.5rem 4rem; }
.page-header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
h1 { font-size: 1.55rem; margin: 0; letter-spacing: -.01em; }
.header-meta { display: flex; align-items: center; gap: .6rem; color: var(--ob-muted); font-size: .875rem; }
.unread-pill { display: inline-flex; font-size: .74rem; font-weight: 600; line-height: 1.2; padding: .12rem .5rem; border-radius: 999px; background: var(--unread-accent); color: var(--ob-on-accent); white-space: nowrap; }
.unread-pill.quiet { background: var(--ob-raised); color: var(--ob-muted); font-weight: 500; }
.repo-groups { display: flex; flex-direction: column; gap: 1.15rem; }
.repo-group { border: 1px solid var(--group-border); border-radius: 8px; overflow: hidden; }
.repo-header { padding: .5rem .95rem; background: var(--ob-surface); border-bottom: 1px solid var(--group-border); }
.repo-name { margin: 0; font: 600 .8rem/1.5 ui-monospace, SFMono-Regular, monospace; letter-spacing: .02em; color: var(--ob-muted); overflow-wrap: anywhere; }
.hub-list, .unread-list { list-style: none; padding: 0; }
.hub-list { margin: 0; }
.hub-row { padding: .9rem .95rem; border-bottom: 1px solid var(--group-border); overflow-wrap: anywhere; }
.hub-row:last-child { border-bottom: 0; }
.hub-title-wrap { display: flex; align-items: center; gap: .55rem; flex-wrap: wrap; }
.hub-link { color: var(--ob-orange); font-weight: 600; font-size: 1rem; text-decoration: none; }
.hub-link:hover { text-decoration: underline; }
.workspace-badge { font: .74rem/1.2 ui-monospace, SFMono-Regular, monospace; padding: .1rem .45rem; border-radius: 4px; background: var(--ob-raised); color: var(--ob-muted); }
.hub-summary { color: var(--ob-muted); margin: .3rem 0 0; font-size: .92rem; }
.unread-list { margin: .6rem 0 0; display: flex; flex-direction: column; gap: .35rem; }
.unread-list-box { margin: .25rem -.45rem -.35rem; padding: .35rem .45rem; border-radius: 7px; background: var(--unread-bg); max-height: 9.75rem; overflow-y: auto; scrollbar-gutter: stable; }
.unread-list-box .unread-list { margin-top: 0; }
.unread-link { display: inline-flex; align-items: center; gap: .5rem; max-width: 100%; font-size: .86rem; line-height: 1.35; color: var(--ob-fg); background: var(--ob-raised); border: 1px solid var(--unread-border); border-radius: 6px; padding: .28rem .65rem; text-decoration: none; overflow-wrap: anywhere; }
.unread-link:hover { background: var(--unread-accent); color: var(--ob-on-accent); border-color: var(--unread-accent); }
.unread-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--unread-accent); flex: none; }
.unread-link:hover .unread-dot { background: var(--ob-on-accent); }
a:focus-visible, .unread-list-box:focus-visible { outline: 2px solid var(--ob-cyan); outline-offset: 2px; }
.state { color: var(--ob-muted); padding: 1.25rem 0; }
.state h2 { color: var(--ob-fg); font-size: 1rem; margin: 0 0 .35rem; }
.state p { margin: 0; }
[hidden] { display: none !important; }
@media (max-width: 600px) { main { padding: 1.25rem 1rem 3rem; } }
</style>
</head>
<body>
<main>
  <header class="page-header"><h1>Active hubs</h1><div class="header-meta" id="header-meta" hidden></div></header>
  <div class="repo-groups" id="hubs" hidden></div>
  <section class="state" id="state" role="status"><h2 id="state-title">Loading hubs…</h2><p id="state-detail">Looking for active hubs.</p></section>
</main>
<script>
const list = document.querySelector('#hubs');
const meta = document.querySelector('#header-meta');
const state = document.querySelector('#state');
const stateTitle = document.querySelector('#state-title');
const stateDetail = document.querySelector('#state-detail');
const boxes = new Map();
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function renderHub(hub) {
  const row = element('li', 'hub-row');
  const heading = element('div', 'hub-title-wrap');
  const link = element('a', 'hub-link', hub.label);
  link.href = hub.url;
  heading.append(link);
  if (hub.workspace) heading.append(element('span', 'workspace-badge', hub.workspace));
  if (hub.unread.length) heading.append(element('span', 'unread-pill', hub.unread.length + ' unread'));
  row.append(heading, element('p', 'hub-summary', hub.summary === null ? 'Working-copy parent unavailable' : hub.summary));
  if (hub.unread.length) {
    const unreadList = element('ul', 'unread-list');
    for (const art of hub.unread) {
      const item = element('li');
      const artLink = element('a', 'unread-link');
      artLink.href = hub.url + '?view=' + encodeURIComponent(art.id);
      const dot = element('span', 'unread-dot');
      dot.setAttribute('aria-hidden', 'true');
      artLink.append(dot, document.createTextNode(art.title));
      item.append(artLink);
      unreadList.append(item);
    }
    if (hub.unread.length > 4) {
      const box = element('div', 'unread-list-box');
      box.tabIndex = 0;
      box.setAttribute('role', 'region');
      box.setAttribute('aria-label', 'Unread artifacts for ' + hub.label);
      box.append(unreadList);
      row.append(box);
      boxes.set(hub.url, box);
    } else row.append(unreadList);
  }
  return row;
}
let lastSelected, lastHubs;
function showState(selected, hubs = []) {
  const serialized = JSON.stringify(hubs);
  if (selected === lastSelected && serialized === lastHubs) return;
  lastSelected = selected;
  lastHubs = serialized;
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  const row = focused?.closest('.hub-row');
  const hubUrl = row?.querySelector('.hub-link')?.getAttribute('href');
  const focusKind = focused?.classList.contains('unread-link') ? 'unread-link' : focused?.classList.contains('unread-list-box') ? 'unread-list-box' : focused?.classList.contains('hub-link') ? 'hub-link' : null;
  const focusHref = focusKind === 'unread-link' ? focused.getAttribute('href') : null;
  const positions = new Map(Array.from(boxes, ([url, box]) => [url, box.scrollTop]));
  boxes.clear();
  const active = selected === 'active';
  list.hidden = !active;
  meta.hidden = !active;
  state.hidden = active;
  if (!active) {
    list.replaceChildren();
    meta.replaceChildren();
    const messages = selected === 'error' ? ['Hubs are unavailable', 'Unable to load active hubs. Retrying…'] : ['No active hubs', 'Start a hub to see it here.'];
    stateTitle.textContent = messages[0];
    stateDetail.textContent = messages[1];
    return;
  }
  const total = hubs.reduce((sum, hub) => sum + hub.unread.length, 0);
  meta.replaceChildren(element('span', 'unread-pill' + (total ? '' : ' quiet'), total ? total + ' unread' : 'All caught up'), element('span', '', hubs.length + (hubs.length === 1 ? ' hub' : ' hubs')));
  const groups = new Map();
  for (const hub of hubs) {
    const repo = hub.repo || '';
    if (!groups.has(repo)) groups.set(repo, []);
    groups.get(repo).push(hub);
  }
  const sections = Array.from(groups.keys()).sort((a, b) => !a ? 1 : !b ? -1 : a.localeCompare(b)).map(repo => {
    const section = element('section', 'repo-group');
    if (repo) {
      const header = element('div', 'repo-header');
      header.append(element('h2', 'repo-name', repo));
      section.append(header);
    }
    const hubList = element('ul', 'hub-list');
    groups.get(repo).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)).forEach(hub => hubList.append(renderHub(hub)));
    section.append(hubList);
    return section;
  });
  list.replaceChildren(...sections);
  for (const [url, box] of boxes) box.scrollTop = positions.get(url) || 0;
  if (focusKind && hubUrl) {
    const hubLink = Array.from(list.querySelectorAll('.hub-link')).find(link => link.getAttribute('href') === hubUrl);
    const replacementRow = hubLink?.closest('.hub-row');
    const replacement = focusKind === 'unread-link'
      ? Array.from(replacementRow?.querySelectorAll('.unread-link') || []).find(link => link.getAttribute('href') === focusHref)
      : focusKind === 'unread-list-box' ? boxes.get(hubUrl) : hubLink;
    (replacement || hubLink)?.focus({ preventScroll: true });
  }
}
let timer;
let generation = 0;
async function refresh() {
  const current = ++generation;
  clearTimeout(timer);
  try {
    const response = await fetch('/api/hubs', { cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to load hubs');
    const data = await response.json();
    if (current === generation) showState(data.hubs.length ? 'active' : 'empty', data.hubs);
  } catch {
    if (current === generation) showState('error');
  } finally {
    if (current === generation && !document.hidden) timer = setTimeout(refresh, 5000);
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(timer); generation++; }
  else refresh();
});
if (!document.hidden) refresh();
</script>
</body>
</html>`;
