import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertOutsideRepo, atomicWrite, repoRoot } from './files.mjs';
import { openReview } from './lavish.mjs';
import { recordWatch, retarget, withPublication } from './relay.mjs';
import { documentOutputPath, writeTaskPage } from './document-page.mjs';
import { preparePR, writePRPage } from './pr-page.mjs';
import { ensureDeps } from './deps.mjs';
import { DiffUsageError, prepareDiff, readDiff } from './diff/source.mjs';
import { pagePath, writeDiffPage } from './diff/page.mjs';
import { callHub, runHubOwner } from './hub-runtime.mjs';
import { readMetadata } from './hub-documents.mjs';

const usage = `usage: lavish-kit <file.html|file.md|file.markdown> [--title T] [--out FILE] [--open] [--reopen]
       lavish-kit diff [-r REV | --from A --to B] [--git] [--title T] [--out FILE] [--open] [--reopen]
       lavish-kit diff - [--repo-root DIR] [--title T] [--out FILE] [--open] [--reopen]
       lavish-kit pr <pr.md|pr.markdown> [-r REV] [--title T] [--out FILE] [--open] [--reopen]
       lavish-kit retarget <page.html> [--terminal T]
       lavish-kit hub [listen|stop] [--workspace DIR] [--open] [--reopen]
Run lavish-kit --help for details.`;
const help = `Open an HTML file, a Markdown file, or a jj/git diff as a Lavish review page.

usage: lavish-kit <file.html|file.md|file.markdown> [options]
       lavish-kit diff [range] [--git] [options]
       lavish-kit diff - [--repo-root DIR] [options]
       lavish-kit pr <pr.md|pr.markdown> [-r REV] [options]
       lavish-kit retarget <page.html> [--terminal T]

Each command returns once the page is open and its background worker has
started. The worker keeps Markdown and PR pages and jj/git diffs up to
date until the Lavish session ends. Opening the same page again reuses the
worker and switches it to the new source or range.

The command prints where the page is (listed under the herdr task's Artifacts,
or a URL for the user), then one of these lines:
  Feedback is delivered automatically; do not poll <page>.
      The worker sends feedback to the opening Polytoken session (or terminal,
      if it has no session label). Answer with
      lavish-axi reply <page> --agent-reply '...'.
  Feedback requires agent polling: lavish-axi poll <page>.
      Opened outside herdr. Use lavish-axi poll, reply, and end yourself.
Reopening a page outside herdr keeps a worker that is already delivering.
End a review with lavish-axi end <page> or Send & End in the browser.

Retarget sends retained feedback to a new live target. --terminal T takes a
terminal address or unique name. Without it, retarget picks the newest
Polytoken terminal in the page's recorded herdr space. It does not reopen an
ended page or restart a stopped worker.

Markdown documents:
  FILE              edit an existing UTF-8 Markdown file in Rendered/Edit views
  Page Send         sends edits and queued comments; edits are saved only if the
                    file is unchanged on disk. Do not use the sidebar Send.

PR drafts:
  pr FILE [-r REV]  run from the jj repository the PR command should use (default
                    head: @-). FILE starts with "# <title>", then the body.
  Create PR         set createPr to an argv array in
                    ${'${XDG_CONFIG_HOME:-$HOME/.config}'}/lavish-kit/config.json.
                    Without valid config the button is disabled. The worker saves
                    the draft, then runs createPr with -r REV --body-file FILE
                    appended, in a new herdr tab in the recorded repository.
  Config example    {"createPr":["fish","-c","jprc $argv","--"]} for an existing
                    fish jprc function that accepts -r REV --body-file FILE.
                    lavish-kit does not provide jprc or any PR command.

Diff range (jj default: fork_point(trunk() | @) to @; git default: the working
tree against its merge base with origin/HEAD, origin/main, origin/master, main,
or master):
  -r REV            jj revset, or A..B in git
  --from A --to B   diff between two revisions
  --git             use git even inside a jj repository
  -                 read a patch from stdin (not watched); --repo-root DIR sets
                    the root for its paths

Options:
  --title T         title under Artifacts and in delivered feedback (default: the
                    page's <title>, then the file name)
  --out FILE        write the page to FILE, outside the reviewed repository
                    (default: under ${'${XDG_DATA_HOME:-$HOME/.local/share}'}/lavish-kit/pages/;
                    an HTML file is opened where it is)
  --open            open a browser if the page isn't listed under Artifacts
  --reopen          reopen a review the user ended in the browser

Hub owner (experimental; browser views are not yet implemented):
  hub listen [--workspace DIR] [--open] [--reopen]  run a foreground owner
  hub [--workspace DIR]                             check owner status
  hub publish FILE --id ID [--title T] [--metadata-file JSON] [--workspace DIR]
  hub tasks --file FILE [--workspace DIR]            attach a Markdown file
  hub pr [--file FILE] [--rev REV] [--workspace DIR]  configure PR draft and head
  The PR head defaults to @-. Launch saves the draft and resolves the selected
  expression to a full commit ID before opening an interactive terminal.
  hub stop [--workspace DIR]                        stop the owner
  Publication registers a source for the future hub view; it does not yet show
  the document. Metadata accepts reviewedRepository, baseCommit, headCommit and
  sourceUrl. Each publication replaces previous metadata, including omission.
  The owner prints feedback as agent-notification JSON lines and never starts a
  relay. An unreachable owner is not automatically replaced.

See docs/README.md for the save and action formats, worker files, logs, and recovery.`;
class UsageError extends Error {}

export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const target = args.shift();
  if (!target || target.startsWith('-')) throw new UsageError();
  if (target === 'hub') {
    const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'status';
    if (!['listen', 'stop', 'status', 'publish', 'tasks', 'pr'].includes(command)) throw new UsageError(`unknown hub command ${command}`);
    const result = { hub: command };
    if (command === 'publish') {
      result.file = args.shift();
      if (!result.file || result.file.startsWith('-')) throw new UsageError('hub publish requires a file');
    }
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--workspace') {
        if (result.workspace || !args[i + 1] || args[i + 1].startsWith('-')) throw new UsageError('--workspace requires one value');
        result.workspace = args[++i];
      } else if ((command === 'publish' && ['--id', '--title', '--metadata-file'].includes(arg)) || (['tasks', 'pr'].includes(command) && arg === '--file') || (command === 'pr' && arg === '--rev')) {
        const key = arg === '--metadata-file' ? 'metadataFile' : arg.slice(2);
        if (result[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('-')) throw new UsageError(`${arg} requires one value`);
        result[key] = args[++i];
      } else if (command === 'listen' && (arg === '--open' || arg === '--reopen')) {
        const key = arg.slice(2);
        if (result[key]) throw new UsageError(`${arg} given twice`);
        result[key] = true;
      } else throw new UsageError(`unknown hub argument ${arg}`);
    }
    if (command === 'publish' && !result.id) throw new UsageError('hub publish requires --id');
    if (command === 'tasks' && !result.file) throw new UsageError('hub tasks requires --file');
    if (command === 'pr' && !result.file && !result.rev) throw new UsageError('hub pr requires --file or --rev');
    return result;
  }
  if (target === 'retarget') {
    const page = args.shift();
    if (!page || page.startsWith('-')) throw new UsageError('retarget requires a page file');
    if (args.length && (args.length !== 2 || args[0] !== '--terminal' || !args[1] || args[1].startsWith('-'))) throw new UsageError('retarget accepts only --terminal T');
    return { retarget: true, page, terminal: args[1] };
  }
  const diff = target === 'diff', pr = target === 'pr';
  const file = pr ? args.shift() : target;
  if (pr && (!file || file.startsWith('-'))) throw new UsageError(`${target} requires a markdown source file`);
  const result = { target: file, diff, ...(pr ? { pr: true } : {}) };
  const values = new Map([['--title', 'title'], ['--out', 'out'], ...(diff || pr ? [['-r', 'rev']] : []), ...(diff ? [['--from', 'from'], ['--to', 'to'], ['--repo-root', 'repoRoot']] : [])]);
  const switches = new Map([['--open', 'open'], ['--reopen', 'reopen'], ...(diff ? [['--git', 'git']] : [])]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (values.has(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('-')) throw new UsageError(`${arg} requires a value`);
      const key = values.get(arg); if (result[key] !== undefined) throw new UsageError(`${arg} given twice`); result[key] = args[++i];
    } else if (switches.has(arg)) {
      const key = switches.get(arg); if (result[key]) throw new UsageError(`${arg} given twice`); result[key] = true;
    } else if (diff && arg === '-' && !result.stdin) result.stdin = true;
    else throw new UsageError(`unknown argument ${arg}`);
  }
  if (diff && result.rev && (result.from || result.to)) throw new UsageError('-r conflicts with --from/--to');
  if (diff && Boolean(result.from) !== Boolean(result.to)) throw new UsageError('--from and --to must be given together');
  if (diff && result.repoRoot && !result.stdin) throw new UsageError('--repo-root requires a patch on stdin (lavish-kit diff -)');
  if (diff && result.stdin && (result.git || result.rev || result.from || result.to)) throw new UsageError('a patch on stdin conflicts with --git, -r, --from, and --to');
  return result;
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs([...args]);
    if (options.help) { console.log(help); return 0; }
    if (options.hub) {
      if (options.hub === 'listen') return await runHubOwner(options);
      if (['publish', 'tasks', 'pr'].includes(options.hub)) {
        const body = options.hub === 'publish'
          ? { id: options.id, title: options.title, file: path.resolve(options.file), ...(options.metadataFile ? { metadata: await readMetadata(options.metadataFile) } : {}) }
          : { kind: options.hub, ...(options.file ? { file: path.resolve(options.file) } : {}), ...(options.rev ? { rev: options.rev } : {}) };
        await callHub(options.hub === 'publish' ? 'publish' : options.hub === 'pr' ? 'configurePr' : 'attach', { ...options, body });
        console.log(options.hub === 'publish' ? `Registered document ${options.id}.` : `Configured ${options.hub}.`);
        return 0;
      }
      const result = await callHub(options.hub, options);
      console.log(options.hub === 'stop' ? 'Hub owner stopping.' : `Hub owner running for ${result.workspace}${result.available ? '' : ' (workspace unavailable)'}.`);
      return 0;
    }
    if (options.retarget) {
      const result = await retarget(options.page, options.terminal, { log: message => console.error(`lavish-kit: ${message}`) });
      console.log(`Retargeted ${result.target.page} to ${result.target.session || result.target.terminal}; delivered ${result.delivered} outbox batch(es).${result.pending ? ` ${result.pending} batch(es) remain in the outbox.` : ''}`);
      return result.pending ? 1 : 0;
    }
    let root;
    if (!options.diff) {
      const ext = path.extname(options.target).toLowerCase();
      if (options.pr && !['.md', '.markdown'].includes(ext)) throw new UsageError('pr requires a .md or .markdown file');
      if (!['.html', '.md', '.markdown'].includes(ext)) throw new UsageError(`${options.target}: expected a .html, .md, or .markdown file`);
      try { if (!(await stat(options.target)).isFile()) throw new UsageError(); } catch { throw new UsageError(`${options.target}: no such file`); }
      root = repoRoot(path.dirname(await realpath(options.target)));
    } else root = options.repoRoot ? repoRoot(path.resolve(options.repoRoot)) || path.resolve(options.repoRoot) : repoRoot(process.cwd());
    const source = options.diff ? await prepareDiff(options) : null;
    const pr = options.pr ? await preparePR(options.rev) : null;
    if (options.diff) await assertOutsideRepo(pagePath(source, options.out), source.root);
    else if (options.out) {
      await assertOutsideRepo(options.out, root);
      if (pr) await assertOutsideRepo(options.out, pr.repo);
    }
    else if (path.extname(options.target).toLowerCase() !== '.html') {
      const sourceFile = await realpath(options.target);
      const out = documentOutputPath(sourceFile, undefined, pr ? 'pr' : 'markdown');
      await assertOutsideRepo(out, root);
      if (pr) await assertOutsideRepo(out, pr.repo);
    }
    const deps = await ensureDeps();
    const output = options.diff ? pagePath(source, options.out)
      : path.extname(options.target).toLowerCase() === '.html' ? path.resolve(options.out || options.target)
      : documentOutputPath(await realpath(options.target), options.out, pr ? 'pr' : 'markdown');
    const review = await withPublication(output, async () => {
      let settings = options, watch = null;
      if (!options.diff && (pr || path.extname(options.target).toLowerCase() !== '.html')) {
        const page = pr ? await writePRPage(options.target, deps.dist, pr, options) : await writeTaskPage(options.target, deps.dist, { ...options, deps });
        settings = { ...options, title: page.title, sourceFile: page.source, pr };
        watch = { kind: 'document', source: page.source, hash: page.hash };
      } else if (options.diff) {
        const initial = await readDiff(source);
        const { patchHash } = await writeDiffPage(initial, deps.dist, options.out);
        watch = source.kind === 'stdin' ? null : { kind: 'diff', source, hash: patchHash };
      } else if (path.extname(options.target).toLowerCase() === '.html') {
        if (options.out) await atomicWrite(output, await readFile(options.target));
      } else throw new Error(`no renderer for ${options.target}`);
      const generation = randomUUID();
      await recordWatch(output, watch, Boolean(process.env.HC_TERMINAL_ID), generation);
      return { file: output, settings: { ...settings, generation } };
    });
    await openReview(review.file, review.settings);
    return 0;
  } catch (error) {
    if (error instanceof UsageError || error instanceof DiffUsageError) { console.error(error.message ? `lavish-kit: ${error.message}\n${usage}` : usage); return 2; }
    console.error(`lavish-kit: ${error.message}`); return 1;
  }
}
