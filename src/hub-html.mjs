import { parse, parseFragment, serializeOuter } from 'parse5';
import { themeCss } from './orangebox.mjs';

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
