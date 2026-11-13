import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { publishDocument } from './document-page.mjs';
import { writeMarkdown } from './markdown.mjs';
import { diffFingerprint, readDiff } from './diff/source.mjs';
import { writeDiffPage } from './diff/page.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Lavish's documented no-argument command lists non-ended sessions from disk.
// It does not take prompts, claim a listener, or reopen/start the server.
export async function sessionOpen(file, run, decode) {
  const result = decode((await run('lavish-axi', [])).stdout);
  if (!Array.isArray(result.sessions) || result.sessions.some(session => typeof session.file !== 'string')) {
    throw new Error('Lavish session listing has no valid sessions array');
  }
  return result.sessions.some(session => session.file === file && session.status !== 'ended');
}

export async function watchTick(file, spec, deps, state = {}) {
  if (!spec) return state;
  if (spec.kind === 'diff') {
    const fingerprint = spec.source.kind === 'jj' ? await diffFingerprint(spec.source) : null;
    if (fingerprint !== null && fingerprint === state.fingerprint) return state;
    const data = await readDiff(spec.source);
    const nextHash = hash(data.patch);
    if (nextHash !== state.hash) await writeDiffPage(data, deps.dist, file);
    return { hash: nextHash, fingerprint };
  }
  const nextHash = hash(await readFile(spec.source));
  if (nextHash !== state.hash) {
    if (spec.kind === 'document') await publishDocument(file, spec.source);
    else if (spec.kind === 'markdown') await writeMarkdown(spec.source, deps, { out: file });
    else throw new Error(`unknown watch kind: ${spec.kind}`);
  }
  return { hash: nextHash };
}

export async function watchLoop(file, { readSpec, deps, run, decode, log = () => {}, sleep, signal, delivery = () => false, startDelivery = () => {}, interval = 1000 } = {}) {
  let previous, state = {};
  while (!signal?.aborted) {
    let current;
    try {
      current = await readSpec();
      if (current.delivery) startDelivery();
    } catch (error) {
      if (!signal?.aborted) log(`watch spec failed: ${error.message} (still watching)`);
    }
    try {
      if (!delivery() && !await sessionOpen(file, run, decode)) return;
      if (current) {
        const signature = JSON.stringify(current.watch);
        if (signature !== previous) {
          // A previous tick may have published after the opener's initial write.
          // Republish a changed spec once even when its initial hash is unchanged.
          state = previous === undefined ? { hash: current.watch?.hash } : {};
          previous = signature;
        }
        state = await watchTick(file, current.watch, deps, state);
      }
    } catch (error) {
      if (!signal?.aborted) log(`watch failed: ${error.message} (still watching; last version remains on the page)`);
    }
    await sleep(interval);
  }
}
