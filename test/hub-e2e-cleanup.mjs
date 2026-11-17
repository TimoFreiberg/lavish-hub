import { readFile, rm } from 'node:fs/promises';

// Keep scratch evidence if an owned terminal cannot be recovered or removed.
export async function cleanupTerminals({ journal, terminals, dir, run, errors = [] }) {
  try {
    const terminal = JSON.parse(await readFile(journal, 'utf8'));
    if (typeof terminal !== 'string' || !terminal) throw new Error('journal does not contain a terminal ID');
    terminals.push(terminal);
  } catch (error) {
    if (error.code !== 'ENOENT') errors.push(new Error(`Cannot recover terminal journal ${journal}: ${error.message}`, { cause: error }));
  }
  for (const terminal of new Set(terminals)) {
    try { await run('hc', ['kill', terminal]); } catch {}
    try { await run('hc', ['rm', terminal]); }
    catch (error) { errors.push(new Error(`Cannot remove terminal ${terminal}: ${error.message}`, { cause: error })); }
  }
  if (!errors.length) {
    try { await rm(dir, { recursive: true, force: true }); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, `Cleanup failed; scratch evidence retained at ${dir}`);
}
