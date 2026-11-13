import { watchDocumentData } from './document-editor.mjs';
import { byId, status, markdownRenderer, documentEditor, wireDocumentControls } from './document-controls.mjs';

const app = document.getElementById('app');
app.innerHTML = `<header data-lavish-action><h1>Markdown document</h1><p id="source"></p><nav aria-label="Document view"><button id="edit" aria-pressed="false">Edit</button><button id="rendered" aria-pressed="true">Rendered</button><button id="save">Send</button><span>(use this instead of sidebar send)</span></nav><p>Page Send saves edits and sends queued comments.</p><p id="status" role="status">Loading source file…</p><aside id="changed" hidden><p>The file changed on disk. Your unsent edits are kept.</p><button id="reload">Reload (discard mine)</button><button id="keep">Keep mine</button></aside></header><textarea id="editor" aria-label="Markdown text" data-lavish-action spellcheck="false" hidden></textarea><article id="preview" class="document"></article>`;
const textarea = byId('editor'), preview = byId('preview');
const render = markdownRenderer(textarea, preview, { hideFrontMatter: true });
const editor = documentEditor({
  getText: () => textarea.value,
  setText: text => { textarea.value = text; render(); },
});
wireDocumentControls(editor, { body: textarea, preview, render });
watchDocumentData(data => { byId('source').textContent = data.sourceFile; editor.update(data); }, status);
