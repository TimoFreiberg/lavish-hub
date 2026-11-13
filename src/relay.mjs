import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWrite } from './files.mjs';
import { ensureDeps } from './deps.mjs';
import { handleSave } from './save.mjs';
import { saveTag } from './save-message.mjs';
import { actionTag } from './action-message.mjs';
import { handleAction } from './pr-action.mjs';
import { watchLoop } from './watch.mjs';

const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const worker = fileURLToPath(new URL('./relay-worker.mjs', import.meta.url));
const renderer = fileURLToPath(new URL('./watch-renderer.mjs', import.meta.url));

export async function renderWatch(file, spec, _deps, state, signal) {
  if (!spec) return state;
  if (spec.kind !== 'diff') {
    const hash = createHash('sha256').update(await readFile(spec.source)).digest('hex');
    if (hash === state.hash) return state;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [renderer], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], signal });
    let result;
    child.on('message', message => { result = message; });
    child.once('error', reject);
    child.once('exit', (code, reason) => {
      if (code !== 0 || !result) reject(new Error(`watch renderer exited (${reason || code})`));
      else if (result.error) reject(new Error(result.error));
      else resolve(result.result);
    });
    child.send({ file, spec, state });
  });
}
export const relayPaths = file => ({ target: `${file}.relay.json`, watch: `${file}.watch.json`, outbox: `${file}.outbox.json`, lock: `${file}.relay.lock`, stateLock: `${file}.relay-state.lock` });
export function relayLog(file) {
  const id = createHash('sha256').update(file).digest('hex').slice(0, 16);
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'lavish-kit', `relay-${id}.log`);
}
export async function command(name, args) {
  // Polls are indefinite, and hc send may be held while the user is typing.
  return exec(name, args, { maxBuffer: 32 * 1024 * 1024 });
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
async function json(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

async function staleLock(lock, modified) {
  let pid;
  try { pid = Number(await readFile(path.join(lock, 'pid'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return Number.isInteger(pid) && pid > 0 ? !alive(pid) : Date.now() - modified > 5000;
}
const sameLock = (a, b) => a.dev === b.dev && a.ino === b.ino;
// Reclaimers use the same PID/grace-period policy as normal owners, so a
// crashed reclaimer can itself be reclaimed. Never remove a replacement lock.
export async function claimLock(lock, { wait = false, timeout = 120000, deadline = Date.now() + timeout } = {}) {
  while (true) {
    if (Date.now() >= deadline) throw new Error(`relay state is busy (${lock}); retry after delivery finishes`);
    try {
      await mkdir(lock);
      const owned = await stat(lock);
      try { await writeFile(path.join(lock, 'pid'), String(process.pid)); }
      catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
      return async () => {
        try { if (sameLock(owned, await stat(lock))) await rm(lock, { recursive: true, force: true }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    try {
      const observed = await stat(lock);
      if (await staleLock(lock, observed.mtimeMs)) {
        const release = await claimLock(path.join(lock, 'reclaim'), { deadline });
        if (release) {
          let removed = false;
          try {
            // Holding reclaim excludes other removers. Check both ownership and
            // staleness again, including owners still publishing their PID.
            if (sameLock(observed, await stat(lock)) && await staleLock(lock, observed.mtimeMs)) {
              await rm(lock, { recursive: true, force: true });
              removed = true;
            }
          } finally { if (!removed) await release(); }
          continue;
        }
      }
    } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!wait) return null;
    await pause(25);
  }
}
async function withState(file, fn) {
  const release = await claimLock(relayPaths(file).stateLock, { wait: true });
  try { return await fn(); } finally { await release(); }
}
export async function liveTerminals(run = command) {
  const { stdout } = await run('hc', ['ls', '--json']);
  const result = JSON.parse(stdout);
  const terminals = Array.isArray(result) ? result : result.terminals;
  if (!Array.isArray(terminals)) throw new Error('hc ls returned no terminal list');
  const live = terminals.filter(t => t.state === 'live' && !t.rm);
  const detailed = await Promise.all(live.map(async terminal => {
    if (terminal.labels && Number.isFinite(terminal.created_ms)) return terminal;
    try { return JSON.parse((await run('hc', ['get', terminal.address, '--json'])).stdout); }
    catch { return null; } // A terminal can close between list and lookup.
  }));
  return detailed.filter(t => t?.state === 'live' && !t.rm);
}
function recorded(t, previous) {
  return { ...previous, terminal: t.address, session: t.labels?.['polytoken.session'] || null, space: t.labels?.['herdr.space'] || null };
}
export async function recordTarget(file, { title, sourceFile, pr, generation } = {}, run = command) {
  file = await realpath(file);
  const { stdout } = await run('hc', ['get', process.env.HC_TERMINAL_ID, '--json']);
  const terminal = JSON.parse(stdout);
  if (terminal.state !== 'live' || !terminal.address) throw new Error('the opening herdr terminal is not live');
  const target = recorded(terminal, { version: 1, page: file, title, ...(generation ? { generation } : {}), ...(sourceFile ? { sourceFile: path.resolve(sourceFile) } : {}), ...(pr ? { pr } : {}) });
  await withState(file, () => atomicWrite(relayPaths(file).target, JSON.stringify(target, null, 2) + '\n'));
  return target;
}
export function resolveTarget(target, terminals) {
  const matches = terminals.filter(t => target.session ? t.labels?.['polytoken.session'] === target.session : t.address === target.terminal);
  return matches.length === 1 ? matches[0] : null;
}
export function selectRetarget(target, terminals, terminal) {
  if (terminal) {
    const matches = terminals.filter(t => t.address === terminal || t.name === terminal);
    if (matches.length !== 1) throw new Error(`terminal ${terminal} is missing or ambiguous`);
    return matches[0];
  }
  if (!target.space) throw new Error('the page has no recorded herdr.space; pass --terminal T');
  const candidates = terminals.filter(t => t.labels?.['herdr.space'] === target.space && t.labels?.['polytoken.session']);
  if (!candidates.length) throw new Error('no live Polytoken terminal in the recorded herdr.space; pass --terminal T');
  if (candidates.some(t => !Number.isFinite(t.created_ms))) throw new Error('cannot determine the newest terminal; pass --terminal T');
  candidates.sort((a, b) => b.created_ms - a.created_ms);
  if (candidates[1]?.created_ms === candidates[0].created_ms) throw new Error('newest terminal is ambiguous; pass --terminal T');
  return candidates[0];
}
export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function formatMessage(target, batches) {
  const lines = [`Lavish feedback: ${target.title}\nPage: ${target.page}`];
  for (const batch of batches) {
    for (const prompt of batch.prompts || []) {
      const context = [prompt.tag && `Tag: ${prompt.tag}`, prompt.selector && `Selector: ${prompt.selector}`, prompt.text && `Quoted context:\n${String(prompt.text).split('\n').map(line => `> ${line}`).join('\n')}`, prompt.target && `Target: ${JSON.stringify(prompt.target)}`, prompt.attachments?.length && `Attachments: ${JSON.stringify(prompt.attachments)}`].filter(Boolean).join('\n');
      lines.push(`${context}${context ? '\n' : ''}${prompt.prompt || ''}`);
    }
    if (batch.artifact_failures?.length) lines.push(`Fatal artifact failures: ${JSON.stringify(batch.artifact_failures)}`);
    if (batch.session?.session_ended) lines.push('The user ended this review. Do not reopen it uninvited.');
    if (batch.rawOutput) lines.push(`Unparsed Lavish feedback (inspect before acting):\n${batch.rawOutput}`);
  }
  lines.push(`Answer on the page with lavish-axi reply ${quote(target.page)} --agent-reply '...'; do not poll this page (lavish-kit owns its listener).`);
  return lines.join('\n\n');
}

// Save/action handlers return a page reply and optional short agent notice.
// Their payloads never fall through as agent instructions. Results and action
// checkpoints belong to the consumed batch so persistence retries retain them.
export const handledTags = ['lavish-kit-save', 'lavish-kit-action'];
export async function dispatchPrompts(prompts, target, handlers = {}, { results = [], states = [], persist = async () => {}, recovering = false, resolve } = {}) {
  const forwarded = [], replies = [];
  for (const [index, prompt] of prompts.entries()) {
    if (!handledTags.includes(prompt.tag)) { forwarded.push(prompt); continue; }
    if (!results[index]) {
      if (!target) throw new Error('pending feedback is missing its receipt target');
      results[index] = handlers[prompt.tag]
        ? await handlers[prompt.tag](prompt, target, { recovering, resolve, state: states[index], checkpoint: async state => { states[index] = state; await persist(); } })
        : { reply: `${prompt.tag} is not supported by this version of lavish-kit. No file or action was changed.` };
      await persist();
    }
    const result = results[index];
    if (result.reply) replies.push(result.reply);
    if (result.notice) forwarded.push({ prompt: result.notice });
  }
  return { prompts: forwarded, replies };
}
async function reply(file, text, run, log) {
  try { await run('lavish-axi', ['reply', file, '--agent-reply', text]); }
  catch (error) { log(`page reply failed: ${error.stderr?.trim() || error.message}`); }
}
async function flushLocked(file, target, run, log) {
  const outbox = await json(relayPaths(file).outbox, []);
  if (outbox.some(item => item.pending)) throw new Error('outbox has unfinished handlers; restart the relay to recover before retargeting');
  const replies = outbox.flatMap(item => item.replies || []);
  const deliverable = outbox.filter(item => item.feedback.prompts?.length || item.feedback.artifact_failures?.length || item.feedback.rawOutput);
  if (!deliverable.length) {
    if (outbox.length) await atomicWrite(relayPaths(file).outbox, '[]\n');
    if (replies.length) await reply(file, replies.join('\n'), run, log);
    return { delivered: 0 };
  }
  let terminal, failure;
  try {
    terminal = resolveTarget(target, await liveTerminals(run));
    if (terminal) await run('hc', ['send', terminal.address, formatMessage(target, outbox.map(item => item.feedback))]);
  } catch (error) { failure = error.stderr?.trim() || error.message; log(`delivery failed: ${failure}`); }
  if (!terminal || failure) {
    const text = `${failure ? 'Terminal delivery failed' : 'The recorded session or terminal is gone or ambiguous'}. Feedback is kept in ${relayPaths(file).outbox}. Retarget with lavish-kit retarget ${quote(file)} [--terminal T].`;
    await reply(file, [...replies, text].join('\n'), run, log);
    return { delivered: 0, pending: outbox.length };
  }
  // Keep the outbox until hc accepts the send. A crash in this small window
  // can replay a batch, so delivery is at-least-once.
  await atomicWrite(relayPaths(file).outbox, '[]\n');
  await reply(file, [...replies, `Delivered to ${target.session || terminal.address}`].join('\n'), run, log);
  return { delivered: outbox.length, terminal: terminal.address };
}
const consumedBatches = new WeakMap();
async function processPending(file, target, outbox, handlers, write, run, recovering = false) {
  const persist = () => write(relayPaths(file).outbox, JSON.stringify(outbox, null, 2) + '\n');
  const resolve = async () => resolveTarget(target, await liveTerminals(run));
  for (const item of outbox) {
    if (!item.pending) continue;
    if (!item.target) throw new Error('pending feedback is missing its receipt target');
    const dispatched = await dispatchPrompts(item.feedback.prompts || [], item.target, handlers, { results: item.results, states: item.states, persist, recovering, resolve });
    item.feedback = { ...item.feedback, prompts: dispatched.prompts };
    item.replies = dispatched.replies;
    item.pending = false;
    delete item.results; delete item.states; delete item.target;
    await persist();
  }
}
export async function deliverFeedback(file, feedback, { run = command, log = () => {}, handlers = {}, write = atomicWrite, durable = () => {}, signal } = {}) {
  let item = consumedBatches.get(feedback);
  if (!item) {
    item = { id: randomUUID(), receivedAt: new Date().toISOString(), feedback, pending: true, results: [], states: [] };
    consumedBatches.set(feedback, item);
  }
  const result = await withState(file, async () => {
    const target = await json(relayPaths(file).target);
    // Freeze the save/launch inputs before any side effect. Retargeting only
    // changes where feedback goes and which space Create PR opens in.
    if (item.pending) item.target ||= { ...target, ...(target.sourceFile ? { sourceFile: await realpath(target.sourceFile).catch(() => path.resolve(target.sourceFile)) } : {}) };
    const outbox = await json(relayPaths(file).outbox, []);
    const index = outbox.findIndex(batch => batch.id === item.id);
    if (index < 0) outbox.push(item); else outbox[index] = item;
    // Store consumed input before any source replacement or external launch.
    await write(relayPaths(file).outbox, JSON.stringify(outbox, null, 2) + '\n');
    durable();
    // Shutdown may have been waiting for this first durable copy. Leave the
    // pending batch for recovery rather than starting handlers or delivery.
    if (signal?.aborted) return { pending: outbox.length };
    await processPending(file, target, outbox, handlers, write, run);
    return flushLocked(file, target, run, log);
  });
  consumedBatches.delete(feedback);
  return result;
}
const recoveryDir = () => path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'lavish-kit', 'recovery');
async function importRecovery(file, write, log) {
  const dir = recoveryDir();
  let names;
  try { names = await readdir(dir); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const outbox = await json(relayPaths(file).outbox, []);
  for (const name of names.filter(name => name.endsWith('.json')).sort()) {
    const recordPath = path.join(dir, name);
    let record;
    try { record = await json(recordPath); } catch (error) { log(`recovery record ${recordPath} cannot be read: ${error.message}`); continue; }
    if (record.page !== file) continue;
    const item = record.item;
    if (!item?.id || !item.feedback || (item.pending && !item.target)) {
      log(`recovery record ${recordPath} needs manual inspection`);
      throw new Error(`invalid recovery record: ${recordPath}`);
    }
    if (!outbox.some(existing => existing.id === item.id)) {
      outbox.push(item);
      await write(relayPaths(file).outbox, JSON.stringify(outbox, null, 2) + '\n');
    }
    await rm(recordPath);
    log(`recovered feedback from ${recordPath}`);
  }
}
export async function recoverFeedback(file, { run = command, log = () => {}, handlers = {}, write = atomicWrite } = {}) {
  return withState(file, async () => {
    const target = await json(relayPaths(file).target);
    await importRecovery(file, write, log);
    await processPending(file, target, await json(relayPaths(file).outbox, []), handlers, write, run, true);
    return flushLocked(file, target, run, log);
  });
}
export async function retarget(file, terminal, { run = command, log = () => {} } = {}) {
  file = await realpath(file);
  return withState(file, async () => {
    const previous = await json(relayPaths(file).target);
    const next = recorded(selectRetarget(previous, await liveTerminals(run), terminal), previous);
    await atomicWrite(relayPaths(file).target, JSON.stringify(next, null, 2) + '\n');
    return { target: next, ...await flushLocked(file, next, run, log) };
  });
}
export async function recordWatch(file, watch, delivery = false, generation) {
  file = await realpath(file);
  await atomicWrite(relayPaths(file).watch, JSON.stringify({ version: 1, delivery, watch: watch || null, ...(generation ? { generation } : {}) }, null, 2) + '\n');
  return file;
}
// Keep opener writes and watch ticks ordered without waiting for terminal sends.
export async function withPublication(file, fn) {
  await mkdir(path.dirname(file), { recursive: true });
  const release = await claimLock(`${file}.publication.lock`, { wait: true });
  try { return await fn(); } finally { await release(); }
}
export async function ensureRelay(file) {
  const log = relayLog(file);
  await mkdir(path.dirname(log), { recursive: true });
  const output = await open(log, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [worker, file], { detached: true, stdio: ['ignore', output.fd, output.fd, 'ipc'] });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`relay startup timed out; see ${log}`)); }, 10000);
      const done = (error, result) => { clearTimeout(timer); child.removeAllListeners('exit'); if (child.connected) child.disconnect(); child.unref(); error ? reject(error) : resolve(result); };
      child.once('error', done);
      child.once('exit', code => done(new Error(`relay exited before startup (${code}); see ${log}`)));
      child.once('message', result => done(result.error ? new Error(`${result.error}; see ${log}`) : undefined, result));
    });
  } finally { await output.close(); }
}
export async function pollLoop(file, { run = command, decode, deliver = deliverFeedback, log = () => {}, sleep = pause, signal, healthy = () => {}, consumed = () => {}, forced = () => false, emergency = async () => {} } = {}) {
  let failures = 0;
  while (!signal?.aborted) {
    let feedback;
    try {
      healthy(true);
      const { stdout } = await run('lavish-axi', ['poll', file, '--owner', `lavish-kit:${file}`]);
      try { feedback = decode(stdout); }
      catch (error) {
        log(`could not decode poll output: ${error.message}`);
        feedback = { rawOutput: stdout };
      }
    } catch (error) {
      healthy(false);
      const text = error.stderr?.trim() || error.message;
      log(`poll failed: ${text}`);
      if (signal?.aborted || /LISTENER_REPLACED|NOT_FOUND/.test(text)) return;
      await sleep(Math.min(30000, 500 * 2 ** Math.min(failures++, 6)));
      continue;
    }
    if (feedback.prompts?.length || feedback.artifact_failures?.length || feedback.rawOutput) {
      // Once poll consumes a response, retry persistence/delivery rather than
      // polling again and forgetting that response.
      let persisted = false, attempts = 0;
      consumed(true);
      const durable = () => { persisted = true; consumed(false); };
      while ((!signal?.aborted || !persisted) && !forced()) {
        try { await deliver(file, feedback, { run, log, durable, signal }); durable(); break; }
        catch (error) {
          healthy(false); log(`feedback persistence failed: ${error.message}`);
          if (!persisted && ++attempts >= 3) {
            await emergency(file, feedback, error);
            consumed(false);
            return;
          }
          await sleep(1000);
        }
      }
      if (!persisted && forced()) { await emergency(file, feedback, new Error('forced shutdown')); consumed(false); return; }
    }
    if (feedback.session?.status === 'ended' || feedback.session?.session_ended || feedback.artifact_failures?.length) return;
    healthy(false);
    if (feedback.session?.status !== 'feedback') await sleep(Math.min(30000, 500 * 2 ** Math.min(failures++, 6)));
    else failures = 0;
  }
}
export async function deliveryReady(file) {
  const spec = await json(relayPaths(file).watch);
  if (!spec.delivery) return false;
  if (!spec.generation) return true;
  const target = await json(relayPaths(file).target, null);
  return target?.generation === spec.generation;
}
export async function relayMain(file, { write = atomicWrite } = {}) {
  const log = message => console.error(`${new Date().toISOString()} ${message}`);
  let release;
  const controller = new AbortController();
  let undurableBatch = false, stopping = false, forceStop = false;
  const stop = () => { stopping = true; if (!undurableBatch) controller.abort(); };
  const onSignal = () => {
    if (stopping && undurableBatch) {
      forceStop = true;
      log('FORCED SHUTDOWN: attempting emergency feedback storage');
      controller.abort();
    } else stop();
  };
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
  try {
    release = await claimLock(relayPaths(file).lock);
    if (!release) {
      const delivery = await json(path.join(relayPaths(file).lock, 'delivery'), false);
      const requested = (await json(relayPaths(file).watch)).delivery;
      if (process.connected) process.send({ running: true, delivery: delivery || Boolean(requested) });
      return;
    }
    const deps = await ensureDeps();
    const { decode } = await import(pathToFileURL(deps.resolve('@toon-format/toon')).href);
    log(`relay started for ${file} (pid ${process.pid})`);
    const run = (name, args) => exec(name, args, { maxBuffer: 32 * 1024 * 1024, signal: controller.signal });
    const sleep = async ms => { try { await delay(ms, undefined, { signal: controller.signal }); } catch (error) { if (error.name !== 'AbortError') throw error; } };
    const handlers = {
      [saveTag]: handleSave,
      [actionTag]: (prompt, target, context) => handleAction(prompt, target, { ...context, run }),
    };
    let deliveryTask, healthyPoll = false;
    const startDelivery = async () => {
      if (deliveryTask) return;
      if (!await deliveryReady(file)) return;
      await atomicWrite(path.join(relayPaths(file).lock, 'delivery'), 'true\n');
      deliveryTask = (async () => {
        // Finish consumed input and durable deliveries before polling again.
        while (!controller.signal.aborted) {
          try { await recoverFeedback(file, { run, log, handlers }); break; }
          catch (error) { log(`outbox recovery failed: ${error.message}; retrying before poll`); await sleep(1000); }
        }
        await pollLoop(file, { run, decode, log, sleep, signal: controller.signal,
          healthy: value => { healthyPoll = value; },
          emergency: async (page, feedback, cause) => {
            const item = consumedBatches.get(feedback) || { id: randomUUID(), receivedAt: new Date().toISOString(), feedback, pending: true, results: [], states: [] };
            const dir = recoveryDir();
            const destination = path.join(dir, `${item.id}.json`);
            try {
              await atomicWrite(destination, JSON.stringify({ page, item }, null, 2) + '\n');
              log(`EMERGENCY: feedback saved to ${destination}; see docs/feedback-routing.md for recovery. Outbox error: ${cause.message}`);
            } catch (error) {
              log(`EMERGENCY: feedback could not be saved to the outbox or ${destination}; feedback may be lost: ${error.message}`);
              process.exitCode = 1;
            }
          },
          consumed: value => { undurableBatch = value; if (!value && stopping) stop(); },
          forced: () => forceStop,
          deliver: (page, feedback, options) => deliverFeedback(page, feedback, { ...options, handlers, write }),
        });
      })().catch(error => log(`delivery stopped: ${error.message}`)).finally(stop);
    };
    const readSpec = () => json(relayPaths(file).watch);
    if ((await readSpec()).delivery) await startDelivery();
    if (process.connected) process.send({ running: true, delivery: Boolean(deliveryTask) });
    const exists = async name => { try { await stat(name); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
    const stateDir = process.env.LAVISH_AXI_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'lavish-axi');
    const stateFile = path.join(stateDir, 'state.json');
    const hadState = await exists(stateFile);
    await watchLoop(file, { readSpec, deps, run, decode, log, sleep, signal: controller.signal,
      disappeared: async () => (!await exists(file) && !await exists(relayPaths(file).watch) && !await exists(relayPaths(file).target)) || (hadState && !await exists(stateFile)),
      startDelivery, delivery: () => healthyPoll, publish: fn => withPublication(file, fn),
      tick: (page, spec, dependencies, state) => renderWatch(page, spec, dependencies, state, controller.signal),
    });
    stop();
    if (deliveryTask) await deliveryTask;
    log('relay stopped');
  } catch (error) { if (process.connected) process.send({ error: error.message }); log(error.stack || error.message); process.exitCode = 1; }
  finally { if (release) await release(); process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal); }
}
