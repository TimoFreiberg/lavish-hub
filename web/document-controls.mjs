import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import anchor from 'markdown-it-anchor';
import frontMatter from 'markdown-it-front-matter';
import shiki from '@shikijs/markdown-it';
import { parse, stringify } from 'yaml';
import { createDocumentEditor } from './document-editor.mjs';
import { accessibleCodeBlocks } from '../src/markdown-accessibility.mjs';

let highlighting;
export const byId = id => document.getElementById(id);
export const status = text => { byId('status').textContent = text; };
export function markdownRenderer(body, preview, { hideFrontMatter = false, onTaskToggle, afterRender = () => {}, onError = error => status(`Syntax highlighting unavailable: ${error.message}`) } = {}) {
  const md = new MarkdownIt({ html: true, linkify: true });
  let metadata = '';
  md.use(taskLists, { label: true }).use(anchor, { permalink: anchor.permalink.linkInsideHeader({ symbol: '#' }) });
  if (hideFrontMatter) md.use(frontMatter, raw => {
    try {
      const data = parse(raw);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const rows = Object.entries(data).map(([key, value]) => {
          const display = value !== null && typeof value === 'object' ? stringify(value).trimEnd() : String(value ?? '');
          return `<tr><th scope="row">${md.utils.escapeHtml(key)}</th><td>${md.utils.escapeHtml(display)}</td></tr>`;
        }).join('\n');
        metadata = `<table class="metadata"><tbody>${rows}</tbody></table>`;
      } else if (data !== null && data !== undefined) metadata = `<pre>${md.utils.escapeHtml(raw)}</pre>`;
    } catch { metadata = `<pre>${md.utils.escapeHtml(raw)}</pre>`; }
  });
  if (onTaskToggle) md.core.ruler.after('github-task-lists', 'task-source-lines', state => {
    for (const token of state.tokens) {
      if (token.type !== 'inline' || !token.map) continue;
      const checkbox = token.children?.find(child => child.type === 'html_inline' && child.content.startsWith('<input class="task-list-item-checkbox"'));
      if (checkbox) checkbox.content = checkbox.content.replace('<input ', `<input data-task-line="${token.map[0]}" `);
    }
  });
  const render = () => {
    metadata = ''; const html = md.render(body.value); preview.innerHTML = metadata + html;
    if (onTaskToggle) for (const checkbox of preview.querySelectorAll('input[data-task-line]')) {
      checkbox.disabled = false;
      checkbox.addEventListener('change', () => onTaskToggle(Number(checkbox.dataset.taskLine), checkbox.checked));
    }
    afterRender(preview);
  };
  highlighting ||= shiki({ themes: { light: 'github-light', dark: 'github-dark' }, fallbackLanguage: 'text' });
  highlighting.then(plugin => { md.use(plugin).use(accessibleCodeBlocks); render(); }).catch(onError);
  return render;
}
export function documentEditor(options) {
  return createDocumentEditor({ ...options, changed: value => { byId('changed').hidden = !value; }, status });
}
export function wireDocumentControls(editor, { body, preview, render, inputs = [body], save = editor.save }) {
  byId('save').onclick = save;
  byId('reload').onclick = editor.reload;
  byId('keep').onclick = editor.keep;
  for (const view of ['edit', 'rendered']) byId(view).onclick = () => {
    body.hidden = view !== 'edit'; preview.hidden = view !== 'rendered';
    byId('edit').setAttribute('aria-pressed', String(view === 'edit'));
    byId('rendered').setAttribute('aria-pressed', String(view === 'rendered'));
    if (view === 'rendered') render();
  };
  for (const input of inputs) input.addEventListener('input', () => status(editor.dirty() ? 'Unsent edits' : 'Saved — up to date with disk'));
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); event.stopPropagation(); status('Use the page Send button to save edits and send queued comments.');
    }
  }, true);
  window.addEventListener('beforeunload', event => { if (editor.dirty()) { event.preventDefault(); event.returnValue = ''; } });
}
