export function normalizeFilePath(raw) {
  return String(raw ?? '').trim().replace(/^(?:\.\/|\/)+/, '');
}

export function parseLineSpec(raw) {
  const match = /^([1-9]\d{0,7})(?:-([1-9]\d{0,7}))?$/.exec(String(raw ?? ''));
  if (!match) return null;
  const start = Number(match[1]), end = Number(match[2] || match[1]);
  return end >= start ? { start, end } : null;
}

export function resolveFileEntry(files, rawPath) {
  const path = normalizeFilePath(rawPath);
  if (!path) return null;
  let index = files.findIndex(file => file.newPath === path);
  if (index < 0) index = files.findIndex(file => file.oldPath === path);
  return index < 0 ? null : { file: files[index], index };
}

export function resolveTargetSide(file, rawSide) {
  return rawSide === 'old' || (rawSide !== 'new' && file.status === 'deleted') ? 'deletions' : 'additions';
}

export function isRangeInHunks(parsed, start, end, side) {
  let next = start;
  const prefix = side === 'deletions' ? 'deletion' : 'addition';
  for (const hunk of parsed?.hunks || []) {
    const first = hunk[`${prefix}Start`], last = first + hunk[`${prefix}Count`] - 1;
    if (next < first) return false;
    if (next <= last) next = last + 1;
    if (next > end) return true;
  }
  return false;
}

export function fileLineCount(fullFiles, side) {
  const contents = (side === 'deletions' ? fullFiles?.oldFile : fullFiles?.newFile)?.contents;
  if (typeof contents !== 'string' || !contents) return 0;
  return contents.split('\n').length - (contents.endsWith('\n') ? 1 : 0);
}
