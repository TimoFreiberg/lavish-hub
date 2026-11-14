import { decodeSave, saveTag } from '../src/save-message.mjs';
import { decodeAction, actionTag } from '../src/action-message.mjs';

// This bundle is included only in generated preview pages.
let data, initial, listener, queued = [], sequence = 0;
const hash = () => (++sequence).toString(16).padStart(64, '0');
const notify = () => queueMicrotask(() => listener?.({ ...data }));
const receipt = text => { document.getElementById('preview-receipt').textContent = text; };
const adapter = {
  subscribe(update) {
    listener = update;
    globalThis.lavishViewLatest = value => {
      const script = document.createElement('script');
      script.src = `./data-${encodeURIComponent(value)}.js`;
      document.head.append(script);
    };
    globalThis.lavishViewData = value => { initial = { ...value }; data = { ...value }; notify(); };
    const script = document.createElement('script'); script.src = './latest.js'; document.head.append(script);
    return () => { listener = undefined; };
  },
  queuePrompt(prompt, meta = {}) { queued.push({ prompt, meta }); receipt(`${queued.length} simulated item(s) queued.`); renderQueue(); },
  sendQueuedPrompts() {
    let message = 'Simulated comments sent; no action was run.';
    for (const item of queued) {
      if (item.meta.tag !== saveTag && item.meta.tag !== actionTag) continue;
      const action = item.meta.tag === actionTag;
      const save = action ? decodeAction(item.prompt).save : decodeSave(item.prompt);
      if (!data || save.baseHash !== data.hash) { receipt('Simulated save conflict; the fixture changed.'); notify(); return; }
      data = { ...data, text: save.text, hash: hash() };
      message = action ? 'Simulated Create PR acknowledged; no PR was created.' : 'Simulated save complete; no file was saved.';
    }
    queued = []; renderQueue(); receipt(message); if (data) notify();
  },
};
Object.defineProperty(window, 'lavishPreview', { value: adapter, writable: false, configurable: false });
Object.defineProperty(window, 'lavish', { value: adapter, writable: false, configurable: false });
function renderQueue() {
  const list = document.getElementById('preview-queue'); if (!list) return;
  list.replaceChildren(); queued.forEach((item, index) => {
    const row = document.createElement('li'); row.textContent = item.meta.text || 'Queued item';
    const remove = document.createElement('button'); remove.textContent = 'Remove'; remove.onclick = () => { queued.splice(index, 1); renderQueue(); receipt('Simulated item removed.'); }; row.append(' ', remove); list.append(row);
  });
}
const theme = new URL(location.href).searchParams.get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.dataset.theme = theme;
document.addEventListener('DOMContentLoaded', () => {
  const bar = document.createElement('aside'); bar.setAttribute('aria-label', 'Preview controls');
  bar.style.cssText = 'position:relative;z-index:10;padding:12px;background:#243044;color:white;font:16px system-ui;overflow-wrap:anywhere';
  bar.innerHTML = '<strong>Demo: no files saved or actions run.</strong> <a href="../../index.html" style="color:#b9d9ff">All previews</a> <label>Theme <select aria-label="Theme"><option value="dark">Dark</option><option value="light">Light</option></select></label> <button type="button" id="preview-reset">Reset</button> <button type="button" id="preview-external">Simulate external edit</button> <button type="button" id="preview-send">Send queued comments</button><p id="preview-receipt" role="status" aria-live="polite">Changes are temporary and reset on navigation.</p><ul id="preview-queue"></ul>';
  document.body.prepend(bar);
  if (document.querySelector('.viewport')) { document.body.style.display = 'flex'; document.body.style.flexDirection = 'column'; const app = document.getElementById('app'); app.style.height = 'auto'; app.style.flex = '1'; app.style.minHeight = '0'; }
  const select = bar.querySelector('select'); select.value = theme;
  select.onchange = () => { const url = new URL(location.href); url.searchParams.set('theme', select.value); location.href = url; };
  bar.querySelector('a').href += `?theme=${theme}`;
  bar.querySelector('#preview-reset').onclick = () => { if (confirm('Reset this demo and discard edits?')) location.reload(); };
  const external = bar.querySelector('#preview-external'); external.hidden = !/^(task|pr)-/.test(location.pathname.split('/').at(-3));
  external.onclick = () => { if (!data) return; data = { ...data, text: `${data.text}\nExternal fixture edit.\n`, hash: hash() }; notify(); receipt('Simulated external edit applied.'); };
  bar.querySelector('#preview-send').onclick = () => adapter.sendQueuedPrompts();
  const variant = location.pathname.split('/').at(-3);
  if (variant?.endsWith('-edit')) document.getElementById('edit')?.click();
  if (variant === 'task-changed-on-disk-edit') {
    const wait = setInterval(() => { const input = document.getElementById('editor'); if (!data || !input) return; clearInterval(wait); input.value += '\nMy unsent edit.\n'; input.dispatchEvent(new Event('input', { bubbles: true })); external.click(); }, 10);
  }
});
