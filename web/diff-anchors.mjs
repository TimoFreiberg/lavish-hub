import sha256 from 'js-sha256';

export async function diffDigest(data) {
  const bytes = new TextEncoder().encode(JSON.stringify([data.root || '', data.range || '', data.revision || '', data.patch || '']));
  try {
    if (globalThis.crypto?.subtle) {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
  } catch {}
  return sha256(bytes);
}

export function matchesDiffAnchor(anchor, digest, file) {
  return Boolean(digest && anchor?.digest === digest && anchor.oldPath === file.oldPath && anchor.newPath === file.newPath &&
    (anchor.side === 'additions' || anchor.side === 'deletions') && Number.isSafeInteger(anchor.start) &&
    Number.isSafeInteger(anchor.end) && anchor.start > 0 && anchor.end >= anchor.start);
}
