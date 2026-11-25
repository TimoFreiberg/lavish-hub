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
  --ob-fg: #ebe1cd; --ob-muted: #a89a86; --ob-red: #ffa596; --ob-orange: #f3a762;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--ob-bg); color: var(--ob-fg); font: 15px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { width: min(100%, 68rem); margin: 0 auto; padding: clamp(1rem, 4vw, 3rem); }
.header { display: flex; justify-content: space-between; align-items: end; gap: 1.5rem; margin: .2rem 0 1.8rem; }
.eyebrow { color: var(--ob-orange); font-size: .72rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; margin: 0 0 .55rem; }
h1 { margin: 0; font-size: clamp(1.65rem, 3.8vw, 2.15rem); line-height: 1.15; letter-spacing: -.035em; }
.intro { color: var(--ob-muted); margin: .55rem 0 0; }
.count { color: var(--ob-muted); white-space: nowrap; font-size: .8rem; padding-bottom: .15rem; }
.list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--ob-border); border-radius: .7rem; background: var(--ob-surface); overflow: hidden; }
.entry + .entry { border-top: 1px solid var(--ob-border); }
.hub-card { display: flex; align-items: flex-start; gap: .65rem 1.25rem; padding: 1.2rem 1.4rem; color: var(--ob-fg); text-decoration: none; }
.hub-card:hover { background: var(--ob-raised); }
.hub-card:hover .entry-title { color: var(--ob-orange); }
:focus-visible { outline: 2px solid var(--ob-orange); outline-offset: 3px; border-radius: .15rem; }
.hub-card:focus-visible { outline-offset: -3px; }
.entry-content { flex: 1 1 0; min-width: 0; overflow-wrap: anywhere; }
.entry-title { font-size: 1.02rem; font-weight: 650; line-height: 1.4; }
.unavailable { color: var(--ob-muted); font-size: .78rem; margin-left: .65rem; }
.metadata { display: flex; flex: 0 1 auto; flex-direction: column; align-items: flex-end; gap: .25rem; min-width: 0; max-width: 42%; margin-left: auto; }
.repo { max-width: 100%; border: 1px solid var(--ob-border); border-radius: .3rem; background: var(--ob-raised); color: var(--ob-fg); padding: .14rem .48rem; font-size: .78rem; font-weight: 650; overflow-wrap: anywhere; }
.workspace { display: flex; align-items: flex-start; gap: .3rem; color: var(--ob-muted); font-size: .8rem; min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.workspace svg { flex: none; margin-top: .24em; }
.workspace-name { min-width: 0; }
.state { border: 1px solid var(--ob-border); border-radius: .7rem; background: var(--ob-surface); padding: 2.2rem 1.4rem; }
.state h2 { margin: 0 0 .35rem; font-size: 1rem; }
.state p { margin: 0; color: var(--ob-muted); }
.state.error { border-left: 3px solid var(--ob-red); }
[hidden] { display: none !important; }
@media (max-width: 640px) {
  .hub-card { flex-direction: column; }
  .entry-content { flex: none; width: 100%; }
  .metadata { align-items: flex-start; max-width: 100%; margin-left: 0; }
}
@media (max-width: 520px) {
  main { padding: 1.2rem 1rem; }
  .header { display: block; margin-bottom: 1.35rem; }
  .count { margin-top: .8rem; }
  .hub-card { padding: 1rem; gap: .5rem; }
}
</style>
</head>
<body>
<main>
  <header class="header">
    <div><p class="eyebrow">Lavish Hub</p><h1>Active hubs</h1><p class="intro">Open a hub to continue your work.</p></div>
    <div class="count" id="count"></div>
  </header>
  <ul class="list" id="hubs" aria-label="Active hubs" hidden></ul>
  <section class="state" id="state" role="status"><h2 id="state-title">Loading hubs…</h2><p id="state-detail">Looking for active hubs.</p></section>
</main>
<script>
function renderHub(hub) {
  const item = document.createElement('li');
  item.className = 'entry';
  const link = document.createElement('a');
  link.className = 'hub-card';
  link.href = hub.url;
  const content = document.createElement('div');
  content.className = 'entry-content';
  const title = document.createElement('span');
  title.className = 'entry-title';
  const summary = hub.summary?.trim();
  const promotableSummary = summary && summary !== '(no description)' ? summary : null;
  title.textContent = hub.title || promotableSummary || hub.repo || hub.label;
  content.append(title);
  if (hub.summary === null) {
    const unavailable = document.createElement('span');
    unavailable.className = 'unavailable';
    unavailable.textContent = 'Workspace unavailable';
    content.append(unavailable);
  }
  const metadata = document.createElement('div');
  metadata.className = 'metadata';
  if (hub.repo) {
    const repo = document.createElement('span');
    repo.className = 'repo';
    repo.textContent = hub.repo;
    metadata.append(repo);
  }
  if (hub.workspace && hub.workspace !== hub.repo) {
    const workspace = document.createElement('span');
    workspace.className = 'workspace';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.25');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M3 3.5v5M3 6h3a3 3 0 0 0 3-3');
    svg.append(path);
    for (const [cx, cy] of [[3, 2.5], [3, 9.5], [9, 2.5]]) {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', cx);
      circle.setAttribute('cy', cy);
      circle.setAttribute('r', '1');
      svg.append(circle);
    }
    const name = document.createElement('span');
    name.className = 'workspace-name';
    name.textContent = hub.workspace;
    workspace.append(svg, name);
    metadata.append(workspace);
  }
  link.append(content, metadata);
  item.append(link);
  return item;
}
const list = document.querySelector('#hubs');
const count = document.querySelector('#count');
const state = document.querySelector('#state');
const stateTitle = document.querySelector('#state-title');
const stateDetail = document.querySelector('#state-detail');
function showState(selected, hubs = []) {
  const active = selected === 'active';
  list.hidden = !active;
  state.hidden = active;
  count.textContent = active ? hubs.length + ' active' : '';
  if (active) list.replaceChildren(...hubs.map(renderHub));
  else {
    list.replaceChildren();
    const messages = {
      empty: ['No active hubs', 'Start a hub to see it here.'],
      error: ['Hubs are unavailable', 'Unable to load active hubs. Retrying…']
    };
    stateTitle.textContent = messages[selected][0];
    stateDetail.textContent = messages[selected][1];
    state.classList.toggle('error', selected === 'error');
  }
}
async function refresh() {
  try {
    const response = await fetch('/api/hubs', { cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to load hubs');
    const data = await response.json();
    showState(data.hubs.length ? 'active' : 'empty', data.hubs);
  } catch {
    showState('error');
  }
  setTimeout(refresh, 5000);
}
refresh();
</script>
</body>
</html>`;
