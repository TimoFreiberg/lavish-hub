import { parse } from "parse5";

// Find the browser-parsed body end tag without rewriting artifact bytes.
function findBodyElement(node) {
  if (node.tagName === "body") return node;
  if (!Array.isArray(node.childNodes)) return null;
  for (const child of node.childNodes) {
    const found = findBodyElement(child);
    if (found) return found;
  }
  return null;
}

const bodyCloseCache = new Map();

function bodyCloseIndex(html) {
  if (bodyCloseCache.has(html)) {
    const index = bodyCloseCache.get(html);
    bodyCloseCache.delete(html);
    bodyCloseCache.set(html, index);
    return index;
  }
  const body = findBodyElement(parse(html, { sourceCodeLocationInfo: true }));
  const endTag = body && body.sourceCodeLocation && body.sourceCodeLocation.endTag;
  const index = endTag ? endTag.startOffset : -1;
  if (bodyCloseCache.size === 2) bodyCloseCache.delete(bodyCloseCache.keys().next().value);
  bodyCloseCache.set(html, index);
  return index;
}

export function injectLavishSdk(html, key, artifactRevision, artifactLoadToken = "", context = {}) {
  const hasRevision = artifactRevision !== null && artifactRevision !== undefined && artifactRevision !== "";
  const revisionNumber = hasRevision ? Number(artifactRevision) : Number.NaN;
  const revision = Number.isFinite(revisionNumber) && revisionNumber >= 0 ? Math.trunc(revisionNumber) : null;
  const token = String(artifactLoadToken || "").slice(0, 200);
  let query = `key=${encodeURIComponent(key)}`;
  if (context?.pageProtocol === 1 || context?.page_protocol === 1) {
    query += "&page_protocol=1";
    if (context.page !== undefined && context.page !== null) {
      query += `&page=${encodeURIComponent(String(context.page))}`;
    }
    if (context.pageProof) query += `&page_proof=${encodeURIComponent(String(context.pageProof))}`;
    if (context.servedRoute) query += `&served_route=${encodeURIComponent(String(context.servedRoute))}`;
    if (context.chromeNonce) query += `&chrome_nonce=${encodeURIComponent(String(context.chromeNonce))}`;
    if (context.chromeAuth) query += `&chrome_auth=${encodeURIComponent(String(context.chromeAuth))}`;
  }
  if (revision !== null) query += `&artifact_revision=${revision}`;
  if (token) query += `&artifact_load_token=${encodeURIComponent(token)}`;
  // Resolve against the document URL, not an artifact-authored <base> URL.
  const sdkPath = JSON.stringify(`/sdk.js?${query}`);
  const script = /<base\b/i.test(html)
    ? `<script>document.write('<script src="' + new URL(${sdkPath}, location.href).href + '"><\\/script>')</script>`
    : `<script src="/sdk.js?${query}"></script>`;
  const index = bodyCloseIndex(html);
  if (index !== -1) return `${html.slice(0, index)}${script}${html.slice(index)}`;
  return `${html}\n${script}`;
}
