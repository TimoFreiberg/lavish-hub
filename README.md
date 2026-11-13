# lavish-kit

An unofficial add-on for [Lavish](https://github.com/kunchenguid/lavish-axi).
It prepares HTML, Markdown, and jj/git diffs for browser review, adds editable
task and PR draft pages, and can deliver feedback to an agent running in herdr.

## Requirements and install

Use Node.js 22 or newer, npm, and `lavish-axi` on `PATH`. The editable-page
protocol is tested with Lavish 0.1.96. Diff reviews need jj or git. PR drafts
need jj. The first run installs the pinned npm dependencies and builds the
browser bundles, so it needs network access. Markdown pages also load styling
from a CDN. The command supports macOS and Linux.

Run `bin/lavish-kit` from a checkout, or symlink it into a directory on `PATH`:

```sh
mkdir -p "$HOME/.local/bin"
ln -s "$HOME/src/lavish-kit/bin/lavish-kit" "$HOME/.local/bin/lavish-kit"
lavish-kit --help
```

There is no npm publication or global npm install step. The entry point works
through a symlink. For tests, install `just`, fish, ripgrep, and Playwright's
cached Chromium in addition to the runtime requirements. You can set
`LAVISH_KIT_CHROMIUM` to an existing Chromium executable.

## Commands

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

`--out FILE` overrides the generated page location and must be outside the
reviewed repository. An HTML file opens where it is, or is copied to `--out`.
Markdown renders links, tables, task lists, syntax highlighting, raw HTML, and
frontmatter metadata. Its title comes from frontmatter, the first H1, or the
file name. Every command opens the page and returns after its worker starts.
HTML files are served directly by Lavish (including Lavish's live reload).

The default jj diff is from `fork_point(trunk() | @)` to `@`. The git default
is the working tree against a merge base selected from origin's default
branch, main, or master. `-r REV` selects a jj revset or git `A..B` range.
`--from A --to B` selects two endpoints. `diff -` reads a snapshot from stdin.
The page's detached worker watches jj/git diffs and Markdown, task, and PR
source files until the Lavish session ends. There is no `--watch` option or
foreground watch job. Diff and editable-page data update without reloading
through `latest.js` and versioned data scripts. Markdown changes replace the
rendered HTML, which Lavish live-reloads. Stdin diffs are snapshots.

Diff pages start with native Annotate off. Click a code line or select a range
in the line-number gutter to add a comment beside it. These controls queue
feedback with the path, old/new side, revision, and quoted source. Native
annotations see the renderer's shadow host rather than the clicked line.

## Optional herdr integration

With `HC_TERMINAL_ID` set, lavish-kit records the opening terminal and starts
a detached relay. It needs `hc` on `PATH` to resolve terminals and deliver
feedback. A missing `hc`, or failure to record the target or start the relay,
fails the command rather than silently opening a page without delivery. The
page may already be open when that happens.

Artifacts registration separately uses `herdr-app do task-tree.artifact:...`.
It registers under the task's Artifacts without changing focus. Registration
is optional and silently skipped if `herdr-app`, the mod, or acknowledgement
is unavailable. Without acknowledgement the command prints the URL, and
`--open` opens an external browser (`open` on macOS, `xdg-open` on Linux).
Acknowledged registration does not open an external browser. Relay delivery
still runs if registration fails.

Create PR needs `herdr-app do tab.new`, a live delivery target with a
`herdr.space` label, and a configured PR command. It opens a new terminal in
that space, in the recorded repository. It does not type into the agent's
terminal or fall back to the active space.

Outside herdr (no `HC_TERMINAL_ID`), new pages start the same worker in
watch-only mode, with a watch sidecar but no delivery target. It never polls,
saves, launches commands, or replies. The agent uses `lavish-axi poll`, `reply`,
and `end` itself. The worker checks the documented no-argument `lavish-axi`
session listing, which reads persistent non-ended sessions without consuming
feedback or starting the server. A successful listing that omits the page
ends watching. Listing failures are logged and retried, not treated as end.
The editable-page protocols are described below.

## Relay and recovery

Inside herdr, the relay is the page's only Lavish listener
(`lavish-axi poll --owner`). Agents must not poll these pages themselves. Each
feedback batch becomes one `hc send` message containing the title, page path,
prompts and quoted context, and a `lavish-axi reply` command to answer with.
The relay replies “Delivered to …” on the page after sending.

Delivery follows the opening terminal's `polytoken.session` label, so a
resumed session can move to a different terminal. If the opener has no session
label, delivery stays with that terminal. A missing or ambiguous session never
falls back to its former terminal when another session runs there.

The worker outlives the opening shell and needs no task tab. A lock/PID keeps
one worker per resolved page path. Reopening reuses it and atomically replaces
`<page>.watch.json` with the new source/range, including switching to an HTML
or stdin snapshot with nothing to watch. The worker reloads that spec between
one-second ticks. An in-flight update can finish before the new spec takes
effect. Pending saves/actions keep their original receipt targets.

Reopening a watch-only page inside herdr enables delivery in the same worker.
Once delivery is configured for a page, an outside-herdr reopen preserves it
rather than taking away its listener. Agents must not poll such a page themselves.
Dead-PID locks are reclaimed on the next open. Failed or timed-out polls,
browser disconnects, and `LISTENER_ACTIVE` retry with capped exponential backoff. The relay does
not take over another listener and stops if another listener takes over its
poll. Fatal `artifact_failures` stop it after delivery. Lavish `NOT_FOUND`
means the session ended and stops it without reopening.

End a review with `lavish-axi end "<page>"` or Send & End in the browser. The
relay delivers final feedback before exiting. Use `--reopen` only when the
user asks to reopen a review they ended. To stop only the relay, send TERM to
its PID in `<page>.relay.lock/pid`. Open through lavish-kit again to restart a
stopped or crashed relay. Nothing restarts it automatically.

If delivery fails, the relay retains the batch in the outbox and posts
recovery instructions on the page:

```sh
lavish-kit retarget "<page.html>"
lavish-kit retarget "<page.html>" --terminal T
```

Without `--terminal`, retarget chooses the newest live Polytoken terminal in
the recorded space. It fails if none is live, the space or a terminal's
creation time is unknown, or two terminals tie. An explicit target can be a
live address or unique name, may be in another space, and need not have a
session label. Retarget records the new target and flushes retained feedback,
even if the old target is alive. If flushing fails, the new target remains,
the outbox is retained, and the command exits nonzero. Retarget requires the
existing target sidecar and neither reopens the page nor restarts a worker.

Retarget waits up to 120 seconds for the state lock, then fails rather than
interrupting a send held while the user types. Retry after delivery finishes.
Missing or partial PID files get a five-second grace period. Do not delete a
lock with a running PID.

The relay writes feedback to the outbox before sending. A crash after `hc`
accepts a send but before the outbox clears can deliver it twice. Delivery is
at-least-once, and Lavish has no transactional acknowledgement: a crash
between receiving a poll result and recording it can lose feedback. Failed
page replies are logged and may leave Working visible. Undecodable poll
output is forwarded raw for inspection.

Pending save/action batches retain the source file and PR repository/revision
recorded when received. Reopening a different document at the same page path
cannot redirect that pending work. Delivery and PR terminal placement follow
the current target. Results and launch checkpoints are persisted before full
inputs are replaced with short notices and replies, so an outbox-write retry
does not redo finished work. A restarted relay finishes pending batches before
polling. Retarget cannot flush unfinished work after a crash:
open through lavish-kit to restart recovery, then retarget again if needed.

An interrupted save that finds changed or unreadable disk contents replies
`Interrupted save` and asks the agent to inspect the file. Check the source
and browser edits before choosing Reload or Keep mine. File replacement and
outbox writes are separate atomic renames. Recovery handles process crashes,
not filesystem loss or power failure.

## Editable task documents

`task FILE` requires an existing UTF-8 `.md` or `.markdown` file. It shows Edit
and Rendered views. The preview supports links, tables, task lists and raw
HTML, hides frontmatter, and supports Lavish's native annotations. Save or
Cmd+S (Ctrl+S on Linux) sends the save with any queued feedback.

Disk changes update a clean editor in place. Dirty editors retain edits and
offer Reload (discard mine) or Keep mine. Keep mine bases the next Save on
the new disk version. Watch errors go to the worker log and retry, leaving
the last disk version on the page. Browser data-load failures also retry.

A save carries the full text and SHA-256 of the disk version editing started
from. The relay writes only to the recorded source, never a browser-supplied
path. If the disk still matches the hash, it replaces the file atomically,
preserves its permissions, replies `Saved`, and sends the agent a short notice
to reread it. It never sends the document contents to the agent. Identical
new disk text succeeds without rewriting. Other changes reply `Conflict`
and write nothing. A writer outside the relay can still race the final check
and rename because POSIX has no conditional rename.

Malformed saves, deleted/unreadable sources, and write failures reply
`Save failed` and retain edits. Without the Lavish API, Save shows
`Save unavailable`. Check the page reply: queueing is not confirmation of a
successful save. Leaving with unsaved edits asks for confirmation. The editor
saves UTF-8 with LF newlines. Lavish 0.1.96 caps the whole JSON request at
2 MiB, including escaped text and queued comments. Oversized edits remain
unsaved. Relay poll output is limited to 32 MiB.

The save prompt is `lavish-kit-save/v1`, a newline, and JSON `{baseHash,text}`,
tagged `lavish-kit-save`. It avoids `options.data`, which Lavish appends after
`Context data:` in the prompt text. Outside herdr the polling agent must check
the disk hash, save only if it matches, and reply on the page. The payload is
document text, not agent instructions.

## PR drafts and command config

Run `pr FILE [-r REV]` from the jj repository where the PR command should run.
The file may live elsewhere. Its first line is `# <title>` with a nonempty
single-line title. Everything after the first newline is the body, including
blank and trailing lines:

```markdown
# Add the document editor

Describe the change here.
```

The page shows Title, Body with a Rendered preview, repository, head revset
and commit ID, and commit subjects from trunk to head. Repository/head metadata
is captured at page creation and not updated. The default head is `@-`.
A PR command may evaluate that revset again at launch, so pass an explicit
revision to pin it. Save, conflict handling, watch behavior, annotations,
size limits and agent notices match task pages. Frontmatter is not hidden.
The form writes LF line endings and a newline after the title.

Create PR has no built-in command. Set `createPr` in
`${XDG_CONFIG_HOME:-$HOME/.config}/lavish-kit/config.json` to a nonempty argv
array of strings. The first string must name a command (not be blank), and
strings cannot contain NUL. Empty subsequent arguments are allowed. There is
no shell interpretation unless your argv explicitly starts a shell. For
example, if you already have a fish `jprc` function accepting `-r REV` and
`--body-file FILE`:

```json
{
  "createPr": ["fish", "-c", "jprc $argv", "--"]
}
```

lavish-kit does not provide that function or require fish for other PR
commands. The `--` starts fish's argument list, and `$argv` forwards the
appended arguments without losing spaces, quotes, or Unicode. The test suite
verifies this exact example with a stub fish function, not a real PR command.

Unset, unreadable, malformed, or invalid config disables Create PR with an
explanation naming `createPr`. Reopen the page after changing config to update
the button. The relay reads config again for each action and visibly refuses
missing/invalid config without saving or launching.

Create PR sends `lavish-kit-action/v1`, a newline, then JSON
`{action:"create-pr",save:{baseHash,text}}`, tagged `lavish-kit-action`.
The relay saves first, then appends `-r <recorded rev> --body-file <source>` to
the configured argv and opens `tab.new` in the live target's space and the
recorded repository. A conflict or failed save launches nothing. Continue in
that terminal for your command's interactive steps. A launch acknowledgement
is not confirmation that a PR exists. Command errors appear there.

The launch attempt is recorded before calling herdr. A crash before persisting
herdr's acknowledgement does not automatically launch again, even if the
crash prevented launch. Check herdr before submitting another action, since
each submission is a new launch request.

A malformed draft, non-jj working directory, or head resolving to other than
one commit fails page creation. Invalid disk updates keep browser edits until
the file is fixed. An empty title cannot be submitted. Malformed actions or
missing recorded PR metadata fail visibly. A missing target or space needs
retargeting. Unavailable herdr, unknown/closed spaces, or incomplete launch
acknowledgements fail without choosing another space. A successful save stays
done if launch fails. Outside herdr, the polling agent performs the conditional
save and asks the user to run their configured command.

## Local files and logs

The data root is `${XDG_DATA_HOME:-$HOME/.local/share}/lavish-kit/`. Dependencies
and bundles are cached there. Dependency lock changes reinstall packages,
and build-source changes rebuild bundles. Deleting the cache forces a
reinstall/rebuild. Pages default to `pages/<kind>/<name>-<hash>/index.html`,
where kind is `markdown`, `diff`, `task`, or `pr`. Diff hashes identify the
repository/range, and document hashes identify the resolved source path.

Generated task/PR/diff directories contain `assets/`, `latest.js`, and
`data-<SHA256>.js` (the latest two versions). These contain source text and
local paths. `--out` must be outside the reviewed repository, and PR output
must be outside both the draft's and the command's repository. A
`.lavish-kit-<UUID>.tmp` briefly exists beside the source during Save.

Relay files beside the page:

| File | Contents |
| --- | --- |
| `<page>.watch.json` | Worker version, delivery mode, and current source/range watch spec (also outside herdr) |
| `<page>.relay.json` | Herdr target version, terminal, session label if present, space, page path/title, optional sourceFile, and PR `{repo,rev,head,commits}` |
| `<page>.outbox.json` | Undelivered feedback; unfinished actions also retain full input, receipt target, and progress |
| `<page>.relay.lock/pid` | Worker PID |
| `<page>.relay-state.lock/pid` | Short-lived delivery/retarget/outbox lock |

Keep these files local. Completed entries retain forwarded feedback, short
notices and page replies. Logs are under
`${XDG_STATE_HOME:-$HOME/.local/state}/lavish-kit/relay-<page-hash>.log`, using
the first 16 SHA-256 hex characters of the resolved page path. They record
lifecycle events and errors, not prompts.

## Tests

```sh
just test
just test-e2e
```

`just test` runs `npm ci` and the Node/browser suites. Browser tests start and
end their own Lavish sessions and use cached Chromium. The optional real npm
first-use test runs when `LAVISH_KIT_REAL_NPM=1`.

Run `just test-e2e` explicitly inside herdr. It creates a scratch jj repository,
space, and isolated `hc run --bg --no-parent --no-notify` terminals,
moves a fake session label to verify delivery follows it, and checks exact
saved bytes, page updates, and short agent notices. Create PR uses an absolute
stub command configured through temporary `XDG_CONFIG_HOME`, with real
`tab.new` placement in the recorded space/repository. No PR command or GitHub
access runs. It checks that opening commands return before edits, and that
watch-only Markdown updates in the browser and stops on session end without
polling. The script ends its pages and removes only its own workers, logs,
space, terminals, and temporary files. It does not send to the
terminal you run it from.
