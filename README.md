# lavish-kit

An unofficial add-on for [Lavish](https://github.com/kunchenguid/lavish-axi).
It turns HTML, Markdown, and jj/git diffs into Lavish review pages, adds
editable task and PR draft pages, and can deliver feedback to an agent running
in herdr.

Every page gets a background worker that keeps it up to date while the Lavish
session is open. Inside herdr, the same worker also listens for feedback and
sends it to the agent's terminal, so the agent doesn't have to poll.

## Install

You need Node.js 22 or newer, npm, and `lavish-axi` on `PATH`. The editable
pages are tested with Lavish 0.1.96. Diff pages need jj or git, and PR drafts
need jj. macOS and Linux are supported.

There is no npm package. Run `bin/lavish-kit` from a checkout, or symlink it
into a directory on `PATH` (the entry point works through a symlink):

```sh
mkdir -p "$HOME/.local/bin"
ln -s "$HOME/src/lavish-kit/bin/lavish-kit" "$HOME/.local/bin/lavish-kit"
lavish-kit --help
```

The first run installs the pinned npm dependencies and builds the browser
bundles, so it needs network access. Markdown pages also load their styling
from a CDN.

## Usage

```sh
lavish-kit document.html
lavish-kit notes.md --title "Design review"
lavish-kit diff -r @-
lavish-kit diff --from A --to B
lavish-kit diff --git
jj diff --git | lavish-kit diff - --repo-root "$PWD"
lavish-kit task "$HOME/tasks/example.md" --title "Task document"
lavish-kit pr "$HOME/tasks/example-pr.md" -r @-
lavish-kit retarget "page.html" --terminal T
```

Each command opens the page and returns once its worker has started. It prints
two lines: where the page is, and whether feedback is delivered automatically
or the agent has to poll (see [Feedback](#feedback)).

`--out FILE` overrides where the page is written. It must be outside the
reviewed repository. `--title T` sets the title shown under herdr's Artifacts
and in delivered feedback. `--reopen` reopens a review the user ended; use it
only when they ask.

### HTML and Markdown

An HTML file opens where it is, or is copied to `--out`. Lavish serves it
directly, including its own live reload.

Markdown is rendered to HTML with links, tables, task lists, syntax
highlighting, raw HTML, and a table of frontmatter metadata. The title comes
from frontmatter `title`, the first H1, or the file name. When the source
changes, the worker re-renders the page and Lavish live-reloads it.

### Diffs

The jj default is `fork_point(trunk() | @)` to `@`. The git default is the
working tree against its merge base with `origin/HEAD`, `origin/main`,
`origin/master`, `main`, or `master` (the first one with a merge base). `-r REV` takes a
jj revset, or an `A..B` range in git. `--from A --to B` diffs two revisions.
`--git` uses git even inside a jj repository. `diff -` reads a patch from stdin,
and `--repo-root DIR` sets the root its paths are relative to.

The worker re-reads jj and git diffs every second and publishes new versions
beside the page. The open page checks `latest.js` every two seconds, and when
the diff has changed it shows "Diff changed" with a Refresh button. Refresh
loads the new version in place, without reloading the page. The button is
disabled while a comment draft has text, so finish or cancel the comment first.
A stdin patch is a snapshot and isn't watched.

Diff pages start with Lavish's own Annotate mode off, because Lavish's native
annotations see the diff renderer's shadow host rather than the clicked line.
Click a code line, or select a range in the line-number gutter, to comment
beside it. Each comment is queued as Lavish feedback with the path, old/new
side, revision, and quoted source.

### Task documents

`task FILE` edits an existing UTF-8 `.md` or `.markdown` file in Edit and
Rendered views. The preview supports links, tables, task lists, and raw HTML,
hides frontmatter, and supports Lavish's native annotations. Save (Cmd+S, or
Ctrl+S on Linux) sends the save along with any queued feedback.

The editor follows the file on disk. A clean editor updates in place. With
unsaved edits it keeps them and offers Reload (discard mine) or Keep mine. Keep
mine bases the next Save on the new disk version. If watching fails, the worker
logs the error and retries, and the page keeps showing the last version.
Browser data-load failures also retry.

A save only writes if the file still matches the version editing started from:

- If it matches, the file is replaced atomically with its permissions kept, the
  page replies `Saved`, and the agent gets a short notice to reread the file
  (never the contents).
- If the disk already has the new text, the save succeeds without rewriting.
- Any other change replies `Conflict` and writes nothing.

A writer outside lavish-kit can still race the final check and rename, because
POSIX has no conditional rename. Malformed saves, a deleted or unreadable
source, and write failures reply `Save failed` and keep the edits. Opened
outside Lavish, Save shows `Save unavailable`. Queueing a save doesn't confirm
it, so check the page reply. Leaving with unsaved edits asks for confirmation.

The editor saves UTF-8 with LF newlines. Lavish 0.1.96 caps a whole feedback
request at 2 MiB, including escaped text and queued comments, so larger edits
can't be saved. The worker reads at most 32 MiB of poll output.

### PR drafts

Run `pr FILE [-r REV]` from the jj repository where the PR command should run.
The file can live elsewhere. Its first line is `# <title>` with a nonempty
single-line title, and everything after the first newline is the body,
including blank and trailing lines:

```markdown
# Add the document editor

Describe the change here.
```

The page shows the title, the body with a Rendered preview, the repository,
the head revset and commit ID, and commit subjects from trunk to head. The
default head is `@-`. The repository and head are captured when the page is
created and not updated. A PR command may evaluate the revset again at launch,
so pass an explicit revision to pin it.

Saving, conflicts, watching, annotations, size limits, and agent notices work
as on task pages, except that frontmatter isn't hidden. The form writes LF line
endings and a newline after the title. An empty title can't be submitted.

Page creation fails for a malformed draft, a working directory outside jj, or a
head that doesn't resolve to exactly one commit. If the file on disk becomes
invalid, the page keeps the browser edits until it's fixed.

#### Create PR

Create PR has no built-in command. Set `createPr` in
`${XDG_CONFIG_HOME:-$HOME/.config}/lavish-kit/config.json` to a nonempty array
of strings. The first string must name a command, no string may contain NUL,
and later strings may be empty. The array runs as argv, without a shell unless
you start one. For example, if you already have a fish `jprc` function that
accepts `-r REV` and `--body-file FILE`:

```json
{
  "createPr": ["fish", "-c", "jprc $argv", "--"]
}
```

lavish-kit doesn't provide that function, and other PR commands don't need
fish. The `--` starts fish's argument list, and `$argv` forwards the appended
arguments without losing spaces, quotes, or Unicode. The tests check this
exact example against a stub fish function, not a real PR command.

Missing, unreadable, or invalid config disables the button with an explanation
naming `createPr`. Reopen the page after changing the config to update it. The
worker also reads the config again for each action and refuses to save or
launch without valid config.

Create PR only works inside herdr. It needs `herdr-app do tab.new` and a live
delivery target with a `herdr.space` label. The worker saves the draft first
(a conflict or failed save launches nothing), then appends
`-r <recorded rev> --body-file <source>` to the configured argv and opens a new
tab running it in the target's space and the recorded repository. It never
types into the agent's terminal or falls back to the active space. Continue in
that tab for any interactive steps. Command errors show up there, and a launch
acknowledgement doesn't mean a PR exists.

Malformed actions or missing PR metadata fail on the page. A missing target or
space needs a [retarget](#retarget). If herdr is unavailable, the space is
unknown or closed, or the launch acknowledgement is incomplete, the launch
fails without trying another space. A successful save stays saved when the
launch fails.

## Feedback

### Inside herdr

When `HC_TERMINAL_ID` is set, lavish-kit records the opening terminal and its
worker becomes the page's only Lavish listener (`lavish-axi poll --owner`).
Don't poll these pages yourself. The worker needs `hc` on `PATH`. If `hc` is
missing, or recording the target or starting the worker fails, the command
fails rather than opening a page nobody listens to (the page may already be
open in Lavish at that point).

Each delivery is one `hc send` with the page title and path, the prompts and
quoted context, and the `lavish-axi reply` command to answer with. The worker
then replies "Delivered to …" on the page.

Delivery follows the opening terminal's `polytoken.session` label, so a resumed
session can move to a different terminal. If the opener has no session label,
delivery stays with that terminal. When the session is gone or ambiguous,
delivery never falls back to the old terminal, since another session may be
running there.

lavish-kit also registers the page under the task's Artifacts with
`herdr-app do task-tree.artifact:...`, without changing focus. This is
optional: it's skipped if `herdr-app` or the task-tree mod is missing or doesn't
acknowledge within two seconds. In that case the command prints the URL, and
`--open` opens it in a browser (`open` on macOS, `xdg-open` on Linux). Delivery
works either way.

### Outside herdr

A worker newly started without `HC_TERMINAL_ID` only watches. It never polls,
saves, launches commands, or replies, and the agent runs `lavish-axi poll`,
`reply`, and `end` itself. Reopening a page outside herdr while its worker is
already delivering keeps automatic delivery (see [Reopening](#reopening)), so
follow the printed feedback line rather than assuming you have to poll.

When polling, the agent handles saves itself: check the disk hash, write only
if it matches, and reply on the page. For Create PR, it does that save and asks
the user to run their PR command.

To notice when the review ends, the worker runs `lavish-axi` without arguments,
which lists non-ended sessions without consuming feedback or starting the
server. A successful listing without the page stops the worker. Listing
failures are logged and retried.

### Reopening

There is one worker per resolved page path, guarded by a lock holding its PID.
Opening the page again reuses the running worker and atomically replaces
`<page>.watch.json` with the new source or range (including switching to an
HTML file or stdin patch with nothing to watch). The worker reads that file
between its one-second ticks, so an update already in progress can finish
first. Saves and actions already received keep their original targets.

Reopening a watch-only page inside herdr turns on delivery in the same worker.
Reopening outside herdr keeps delivery in a worker that's already delivering,
but a worker newly started outside herdr only watches, even if the page used
to deliver. The printed feedback line always says which case applies.

## Ending and recovery

End a review with `lavish-axi end "<page>"` or Send & End in the browser. The
worker delivers the final feedback and exits. To stop a worker without ending
the review, send TERM to the PID in `<page>.relay.lock/pid`. Nothing restarts a
stopped or crashed worker automatically. Open the page through lavish-kit again
to start a new one. Locks left by dead processes are reclaimed on the next
open.

Failed or timed-out polls, browser disconnects, and `LISTENER_ACTIVE` are
retried with capped exponential backoff. The worker doesn't take over another
listener, and it stops if another listener takes over its poll. It also stops
after delivering fatal `artifact_failures`, and on Lavish `NOT_FOUND` (the
session ended), without reopening anything.

### Retarget

If delivery fails, the worker keeps the feedback in the outbox and posts these
recovery commands on the page:

```sh
lavish-kit retarget "<page.html>"
lavish-kit retarget "<page.html>" --terminal T
```

Without `--terminal`, retarget picks the newest live Polytoken terminal in the
recorded herdr space. It fails if there is none, if the space or a terminal's
creation time is unknown, or if two terminals tie. `--terminal` takes a live
address or unique name, which may be in another space and needn't have a
session label.

Retarget records the new target and sends the retained feedback, even if the
old target is still alive. If sending fails, the new target stays recorded, the
outbox is kept, and the command exits nonzero. Retarget needs the page's
existing `<page>.relay.json`. It doesn't reopen the page or restart a worker,
and it can't finish saves or actions interrupted by a crash: open the page
through lavish-kit to resume those, then retarget again if needed.

Retarget waits up to 120 seconds for the delivery lock (a send can be held
while the user is typing in the target terminal), then fails. Retry once
delivery finishes. A lock with a missing or partial PID file gets a five-second
grace period. Don't delete a lock whose PID is running.

### Delivery guarantees

The worker writes feedback to the outbox before sending it, so a crash after
`hc` accepts a send but before the outbox is cleared can deliver it twice.
Lavish has no transactional acknowledgement, so a crash between receiving a
poll result and writing it down can lose it. Failed page replies are logged
and can leave "Working" showing on the page. Poll output the worker can't
decode is forwarded raw.

Saves and actions keep the source file and PR repository/revision recorded when
they were received, so reopening a different document at the same page path
can't redirect them. Delivery and the Create PR tab follow the current target.
Results and launch checkpoints are written before the full inputs are replaced
with short notices and replies, so retrying an outbox write doesn't redo
finished work. A restarted worker finishes pending saves and actions before it
polls again.

The launch attempt is recorded before calling herdr. If the worker crashes
before recording herdr's acknowledgement, it won't launch again, even if the
crash prevented the launch. Check herdr before submitting Create PR again,
since each submission is a new launch.

A save interrupted by a crash that later finds changed or unreadable disk
contents replies `Interrupted save` and tells the agent to inspect the file.
Check the source and the browser edits before choosing Reload or Keep mine.
File replacement and outbox writes are separate atomic renames. Recovery covers
process crashes, not filesystem loss or power failure.

## Files and logs

The data root is `${XDG_DATA_HOME:-$HOME/.local/share}/lavish-kit/`. Dependencies
and bundles are cached there: a changed lockfile reinstalls packages, and
changed build inputs rebuild the bundles. Delete the cache to force both.

Pages default to `pages/<kind>/<name>-<hash>/index.html` under the data root,
where kind is `markdown`, `diff`, `task`, or `pr`. Diff hashes identify the
repository and range, and document hashes identify the resolved source path.
Task, PR, and diff page directories also hold `assets/`, `latest.js`, and
`data-<SHA256>.js` (the latest two versions). These contain source text and
local paths, so `--out` must be outside the reviewed repository, and PR pages
must be outside both the draft's and the command's repository. A save briefly
creates `.lavish-kit-<UUID>.tmp` beside the source.

Worker files beside the page:

| File | Contents |
| --- | --- |
| `<page>.watch.json` | Version, whether to deliver, and what to watch (also written outside herdr) |
| `<page>.relay.json` | Delivery target: version, terminal, session label if any, herdr space, page path and title, source file, and PR `{repo,rev,head,commits}` |
| `<page>.outbox.json` | Undelivered feedback, plus the full input, target, and progress of unfinished saves and actions |
| `<page>.relay.lock/` | Worker lock: `pid`, and `delivery` once delivery has started |
| `<page>.relay-state.lock/pid` | Short-lived lock for delivery, retarget, and outbox writes |
| `<page>.publication.lock/pid` | Orders page writes by the opener and the worker |

Keep these files local. Delivered outbox entries keep the forwarded feedback,
short notices, and page replies. Logs are in
`${XDG_STATE_HOME:-$HOME/.local/state}/lavish-kit/relay-<page-hash>.log`, named
by the first 16 hex characters of the SHA-256 of the resolved page path. They
record lifecycle events and errors, not prompts.

## Message formats

Saves and actions are sent as tagged Lavish feedback prompts. Neither uses
`options.data`, which Lavish appends after `Context data:` in the prompt text.

A save is tagged `lavish-kit-save`. Its prompt is `lavish-kit-save/v1`, a
newline, and JSON `{baseHash,text}`, where `baseHash` is the SHA-256 of the
disk version editing started from. The payload is document text, not
instructions for the agent. The worker writes only to the recorded source,
never to a path supplied by the browser.

Create PR is tagged `lavish-kit-action`. Its prompt is `lavish-kit-action/v1`,
a newline, and JSON `{action:"create-pr",save:{baseHash,text}}`.

## Tests

```sh
just test
just test-e2e
```

Tests need `just`, fish, ripgrep, and Playwright's cached Chromium on top of
the runtime requirements. Set `LAVISH_KIT_CHROMIUM` to use another Chromium
executable.

`just test` runs `npm ci` and then the Node and browser suites, one file at a
time. Don't run it twice at once in one checkout: `npm ci` replaces the shared
`node_modules` while the other run reads it. The browser tests also share the
Lavish server and cached Chromium, though each starts and ends its own session.
Set `LAVISH_KIT_REAL_NPM=1` to include a first-run test against the real npm
registry.

Run `just test-e2e` inside herdr. It creates a scratch jj repository, herdr
space, and isolated terminals (`hc run --bg --no-parent --no-notify`), moves a
fake session label to check that delivery follows it, and checks the exact
saved bytes, page updates, and agent notices. Create PR runs an absolute stub
command configured through a temporary `XDG_CONFIG_HOME`, with a real
`tab.new` in the recorded space and repository, so no PR command or GitHub
access is involved. It also checks that opening commands return before edits,
and that a watch-only Markdown page updates in the browser and stops when the
session ends, without polling. The script ends its pages and removes only its
own workers, logs, space, terminals, and temporary files. It never sends to
the terminal you run it from.
