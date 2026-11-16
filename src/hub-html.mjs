import { parse, parseFragment, serializeOuter } from 'parse5';

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
  if (bases.length && bases[0].sourceCodeLocation) {
    const base = bases[0];
    const href = base.attrs.find(attr => attr.name === 'href');
    try { href.value = new URL(href.value, sourceUrl).href; } catch { href.value = sourceUrl; }
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
