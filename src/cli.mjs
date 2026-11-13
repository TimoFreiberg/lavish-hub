import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertOutsideRepo, atomicWrite, repoRoot } from './files.mjs';
import { openReview } from './lavish.mjs';
import { recordWatch, retarget, withPublication } from './relay.mjs';
import { documentOutputPath, writeTaskPage } from './document-page.mjs';
import { preparePR, writePRPage } from './pr-page.mjs';
import { ensureDeps } from './deps.mjs';
import { markdownOutputPath, writeMarkdown } from './markdown.mjs';
import { DiffUsageError, prepareDiff, readDiff } from './diff/source.mjs';
import { pagePath, writeDiffPage } from './diff/page.mjs';

const usage = `usage: lavish-kit <file.html|file.md|file.markdown> [--title T] [--out FILE] [--open] [--reopen]
       lavish-kit diff [-r REV | --from A --to B] [--git] [--title T] [--out FILE] [--open] [--reopen]
       lavish-kit diff - [--repo-root DIR] [--title T] [--out FILE] [--open] [--reopen]
       lavish-kit task <file.md|file.markdown> [--title T] [--out FILE] [--open] [--reopen]
       lavish-kit pr <pr.md|pr.markdown> [-r REV] [--title T] [--out FILE] [--open] [--reopen]
       lavish-kit retarget <page.html> [--terminal T]
Run lavish-kit --help for details.`;
const help = `Open an HTML file, a Markdown file, or a jj/git diff as a Lavish review page.

usage: lavish-kit <file.html|file.md|file.markdown> [options]
       lavish-kit diff [range] [--git] [options]
       lavish-kit diff - [--repo-root DIR] [options]
       lavish-kit task <file.md|file.markdown> [options]
       lavish-kit pr <pr.md|pr.markdown> [-r REV] [options]
       lavish-kit retarget <page.html> [--terminal T]

Each command returns once the page is open and its background worker has
started. The worker keeps Markdown, task, and PR pages and jj/git diffs up to
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

Task documents:
  task FILE         edit an existing UTF-8 Markdown file in Edit/Rendered views
  Save / Cmd+S      (Ctrl+S on Linux) saves only if the file is unchanged on disk;
                    check the page reply

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

See docs/README.md for the save and action formats, worker files, logs, and recovery.`;
class UsageError extends Error {}

export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const target = args.shift();
  if (!target || target.startsWith('-')) throw new UsageError();
  if (target === 'retarget') {
    const page = args.shift();
    if (!page || page.startsWith('-')) throw new UsageError('retarget requires a page file');
    if (args.length && (args.length !== 2 || args[0] !== '--terminal' || !args[1] || args[1].startsWith('-'))) throw new UsageError('retarget accepts only --terminal T');
    return { retarget: true, page, terminal: args[1] };
  }
  const diff = target === 'diff', task = target === 'task', pr = target === 'pr';
  const file = task || pr ? args.shift() : target;
  if ((task || pr) && (!file || file.startsWith('-'))) throw new UsageError(`${target} requires a markdown source file`);
  const result = { target: file, diff, ...(task ? { task: true } : {}), ...(pr ? { pr: true } : {}) };
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
    if (options.retarget) {
      const result = await retarget(options.page, options.terminal, { log: message => console.error(`lavish-kit: ${message}`) });
      console.log(`Retargeted ${result.target.page} to ${result.target.session || result.target.terminal}; delivered ${result.delivered} outbox batch(es).${result.pending ? ` ${result.pending} batch(es) remain in the outbox.` : ''}`);
      return result.pending ? 1 : 0;
    }
    let root;
    if (!options.diff) {
      const ext = path.extname(options.target).toLowerCase();
      if ((options.task || options.pr) && !['.md', '.markdown'].includes(ext)) throw new UsageError(`${options.pr ? 'pr' : 'task'} requires a .md or .markdown file`);
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
      const out = options.task || pr ? documentOutputPath(sourceFile, undefined, pr ? 'pr' : 'task') : markdownOutputPath(sourceFile);
      await assertOutsideRepo(out, root);
      if (pr) await assertOutsideRepo(out, pr.repo);
    }
    const deps = await ensureDeps();
    const output = options.diff ? pagePath(source, options.out)
      : options.task || pr ? documentOutputPath(await realpath(options.target), options.out, pr ? 'pr' : 'task')
      : path.extname(options.target).toLowerCase() === '.html' ? path.resolve(options.out || options.target)
      : markdownOutputPath(await realpath(options.target), options.out);
    const review = await withPublication(output, async () => {
      let settings = options, watch = null;
      if (options.task || pr) {
        const page = pr ? await writePRPage(options.target, deps.dist, pr, options) : await writeTaskPage(options.target, deps.dist, options);
        settings = { ...options, title: page.title, sourceFile: page.source, pr };
        watch = { kind: 'document', source: page.source, hash: page.hash };
      } else if (!options.diff && path.extname(options.target).toLowerCase() !== '.html') {
        const page = await writeMarkdown(options.target, deps, options);
        settings = { ...options, title: options.title ?? page.title };
        watch = { kind: 'markdown', source: page.source, hash: page.hash };
      } else if (options.diff) {
        const initial = await readDiff(source);
        const { patchHash } = await writeDiffPage(initial, deps.dist, options.out);
        watch = source.kind === 'stdin' ? null : { kind: 'diff', source, hash: patchHash };
      } else if (path.extname(options.target).toLowerCase() === '.html') {
        if (options.out) await atomicWrite(output, await readFile(options.target));
      } else throw new Error(`no renderer for ${options.target}`);
      await recordWatch(output, watch, Boolean(process.env.HC_TERMINAL_ID));
      return { file: output, settings };
    });
    await openReview(review.file, review.settings);
    return 0;
  } catch (error) {
    if (error instanceof UsageError || error instanceof DiffUsageError) { console.error(error.message ? `lavish-kit: ${error.message}\n${usage}` : usage); return 2; }
    console.error(`lavish-kit: ${error.message}`); return 1;
  }
}
