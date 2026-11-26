# Workspace hub

`lavish-hub listen [--workspace DIR] [--session ID] [--title TEXT] [--rev REV] [--base REV | --no-base] [--open] [--reopen]` runs a foreground
owner for a jj workspace or repository-scoped session. It opens a stable Lavish page without starting the
standalone feedback relay. The page shows commit descriptions and an annotated
diff, and provides direct Markdown editors for tasks and
registered Markdown documents. Description and file saves report conflicts and
keep the draft on the page. Actions require the local owner; if it is unreachable,
the page reports the error without discarding edits. Drafts are not persisted across
page reloads.

## Runtime

The package includes patched Lavish 0.1.98 and does not use `lavish-axi` on
`PATH`. The hub checks the server's version, patch capability, and state directory
before polling. A different server on the configured port may need to be
stopped or assigned a different port. See [building and releasing](releasing.md)
for package production and [workflow gaps](hub-gaps.md) for removed standalone
capabilities.

The browser uses the Lavish UI address for actions and published document assets.
Forward only that port when developing remotely. The forwarded host and port
can differ from the server's address. The owner still has a private loopback
control listener for CLI commands, but the browser does not connect to it.
Action capabilities, document-resource keys and the artifact sandbox remain
in effect through the UI server. Stopping the owner or ending its review removes
the browser route. Saves and launches are not retried after a lost connection.
Check their outcome before retrying.

Open `/hubs` on the Lavish UI address to see active workspace hubs (`/` redirects
there). Use the **Hubs** link in the Lavish header to return from a session. Links
use the same origin, including a forwarded port.

Hubs are grouped alphabetically by repository, with older sessions first within
each group. Each row shows the hub's title (falling back to the workspace name
for workspace-scoped hubs, or the repository name for session-scoped hubs), the
first line of its tracked revision or working-copy parent description (or
`Working-copy parent unavailable` if the workspace cannot be read), and any
unread publications. Unread publications appear as links that open directly with
`?view=ID` and clear once opened. When a hub has more than four unread
publications, the list scrolls within its row. The page refreshes every five
seconds while visible, catches up when shown again, and drops any owner that
stops refreshing for 45 seconds. Titles and descriptions are visible to anyone
who can access the Lavish server, so avoid putting secrets in them.

## Sessions and targets

By default, a hub is scoped to one jj workspace and tracks its working copy. To run concurrent reviews against the same repository, or to address one hub from the primary checkout and any child workspace, pass `--session ID` or set `LAVISH_HUB_SESSION` (the flag takes precedence). Using the same ID from any checkout of that repository addresses the same owner, while different IDs run independently. Session IDs start with an ASCII letter or digit and contain up to 128 ASCII letters, digits, `.`, `_`, or `-`.

```sh
lavish-hub listen --session review-a --title 'Review A' --rev feature --open
# In another terminal, from the same repository or a child workspace:
lavish-hub target --session review-a --title 'Review A updated'
lavish-hub target --session review-a --base main
```

Because concurrent sessions share a repository, session-scoped `listen` requires
`--rev` even when restarting an existing session. `--title` is optional. The hub
also checks for a Polytoken session matching the hub's session ID,
`POLYTOKEN_SESSION_ID`, or an ancestor process, refreshing that title on startup
and on each hub registration refresh. An explicit `--title` (on `listen` or
`target --title`) takes precedence and is saved in `target.json`, while
looked-up titles stay in memory so live renames are not frozen across restarts. When
neither supplies a title, `/hubs` falls back to the workspace name for
workspace-scoped hubs (with a `workspace` badge) and the repository name for
session-scoped hubs. The sidebar shows the title above the repository name when
available (untitled workspace-scoped hubs show the workspace name), and browser
tabs show `<title> · Lavish` or `<repo> · Lavish` when untitled. Open pages pick
up title changes on their next poll.

`--rev REV` on `listen` or `lavish-hub target REV` sets what the hub tracks. Bookmarks follow moves, and change IDs follow rewrites. Working-copy expressions such as `@` are resolved in the invoking workspace and pinned to that change so the hub can read it without snapshotting or contending with working-copy edits in other workspaces. The target, optional base, and explicit title are saved in `target.json`. Restarting reuses saved settings from `target.json` unless overridden, though session-scoped `listen` still requires `--rev`. `--base REV` chooses a base for the fork point with the target, while `--no-base` returns to the default based on `trunk()`. `target` updates only the supplied fields and needs at least one.

Workspace-scoped hubs normally disable repository actions once their checkout disappears so a replacement checkout at the same path cannot receive actions meant for the old one. To keep a workspace-scoped hub usable after deleting its temporary workspace, run `lavish-hub target @` (or another revision) from that workspace before deletion. Repository operations then run against the primary repository, while source files inside the deleted or replaced workspace stay blocked and managed tasks and external documents remain accessible. Address the owner with its original `--workspace` path after deletion. If the primary repository itself is replaced at the same path, repository actions remain blocked.

## Design priorities

Hub design prioritizes the human end-user experience first, system performance
second, and agent experience third; implementation simplicity comes last. Added
complexity is acceptable when it materially supports a higher priority. These
tradeoffs do not relax safety or correctness requirements.

Start the owner in a terminal or a long-running harness job, not inline in a
script that must continue. Wait for its running message before using short
commands; they never start an owner themselves. For example:

```sh
lavish-hub listen --workspace "$PWD" --open
# In another terminal, after the owner is ready:
lavish-hub publish "$HOME/reviews/review.html" --title "Review" --open
lavish-hub --view review
lavish-hub stop
```

The source must already exist and end in `.html`, `.md`, or `.markdown` (a missing source file returns `VALIDATION_ERROR` with `action=fix_args`). `--id` is optional: if the canonical source file is already registered, omitting `--id` reuses its existing ID. Otherwise the owner derives a lowercase ID from the filename, replacing unsupported characters with hyphens (prepending `doc-` if it does not start with a letter or digit, or appending `-doc` if it matches a built-in view ID). If another source already owns that ID, an eight-hex hash of the canonical path is appended. If that hashed ID also belongs to another source, publication fails with `VALIDATION_ERROR` (`action=fix_args`) and you must pass `--id` explicitly. IDs are 1–64 ASCII letters, digits, underscores, or hyphens, starting with a letter or digit. Built-in view IDs are reserved.

Publishing registers or replaces the document without changing the active browser
view and prints one JSON line with `id`, `url`, `title`, and `scope`. The URL is the
direct `?view=ID` link when available. New or updated publications show a cyan
`New` badge in the sidebar until opened. New publications, updates, and remote
`--view` selections for other views show a bottom-right notification with an Open
button that dismisses after six seconds. `--view ID` changes the default selection
without switching open tabs, and `--open` launches a browser at the selected
document.

By default, publication records the repository name and the base and head commits
of the tracked jj target. If the workspace or repository is unavailable, automatic
scope fails with `WORKSPACE_UNAVAILABLE` (`action=refresh`) so you can pass
`--no-scope` or explicit scope flags. For an external PR, supply explicit scope instead:

```sh
lavish-hub publish review.html --repo org/repo --base-commit BASE_HEX --head-commit HEAD_HEX --source-url https://github.com/org/repo/pull/123
```

`--metadata-file` accepts a JSON object of at most 16 KiB with optional
`reviewedRepository` (nonempty display name), `baseCommit` and `headCommit` (full
40- or 64-digit hex IDs), and `sourceUrl` (HTTP(S) URL). Unknown fields or unreadable
files fail with `VALIDATION_ERROR` (`action=fix_args`). Inline flags override
corresponding file fields. A metadata file or any inline scope flag disables
automatic scope, leaving unspecified fields absent. Use `--no-scope` to publish
without scope (it cannot be combined with a metadata file or inline scope flags).
Each publication replaces previous metadata. Scope is recorded at publication time
and is not updated if commits are rewritten. If generating the published HTML pages
fails, publication retains the previous registration, metadata, selection, and
generated pages when rollback succeeds. A process interruption or filesystem error
during rollback can leave generated pages out of sync. See `lavish-hub publish --help`
for examples.

The sidebar groups viewed, outdated documents under **Older** (hidden when empty).
A viewed document with a `headCommit` in the hub's repository and no `sourceUrl`
moves under **Older** once that commit is outside the tracked stack. If the stack
cannot be read (for example, when the workspace or repository is unavailable), those
documents stay in the main list. Other viewed documents, including unscoped
publications and external reviews, move under **Older** 72 hours after publication.
Unread documents stay in the main list unless you hide them. When you open an
unread document that is already outdated, it stays in the main list while you
read it and moves under **Older** once you navigate away or hide it.

Use the Hide button beside a published document to move it into **Older**, or
Restore to return it to the main list. Hiding an unread document keeps its `New`
badge and its unread link on `/hubs` until you open it. If **Older** is closed,
navigating to a document inside it or moving the active document there opens it.
Republishing clears any Hide or Restore choice and marks the new version unread.

Entering Diff turns Lavish annotations off so you can interact
with the view. Turn the annotation switch back on whenever you want to comment
there. Entering another view turns annotations on. Refreshing the current view
does not change your choice. A browser reload prompts before discarding
unsaved hub drafts, so you can cancel it to keep editing.

Diff shows the commit stack beside its combined diff. Click a commit to view its
changes (clicking that commit again or **All** restores the full stack), or
Shift-click another commit to select a contiguous range. Commits with a body have
a toggle in the rail to preview the rest of the description. Files start
collapsed. Click a file header or **Expand all** to open them, and files you
expand stay open across range changes while present. Click the pencil beside a
mutable, non-divergent commit to edit its description above the diff. Opening the
editor narrows the diff to that commit and restores your previous range when
closed, unless you select another range while editing. Cancel or Escape discards
the edit, and a failed save keeps the draft and shows the error. Both the hub
sidebar (on the hub and on published HTML pages) and the commit rail can be
collapsed or resized.

Tasks display rendered Markdown with interactive checkboxes. Toggling a checkbox
saves it immediately; while saving, the other checkboxes are disabled. If saving
fails, the source editor opens with the draft and an error. Use the pencil to edit
the source of Tasks or published Markdown, then Save or discard with Cancel or
Escape. Published Markdown resolves relative links and images from its source
directory. Queued diff comments appear below their selected lines and in the Lavish
sidebar. Use Edit on a comment to open the sidebar editor, and send comments from
the sidebar. If the diff changes, comments remain in the queue but no longer appear
inline until the same diff is displayed again.
Published HTML opens as a sibling page in the same Lavish review, where it can
be annotated directly. Scripts, styles, and images resolve relative to its source
file, respecting an authored `<base href>`. Local resources remain restricted to
the source directory as described below. Use the sidebar to open built-in views or
published documents. It shows when navigation is in progress; if navigation fails,
select the destination again to retry. The sidebar reserves space at the left of
the page without moving authored elements into a wrapper. Fixed-position content
or styles that override the page's root padding can overlap it. The hub, Markdown,
and diff views use the Orangebox dark palette. Published HTML without a root `data-theme` receives
`data-theme="orangebox"` and a dark background and foreground fallback. Authored
CSS can override the fallback, and an existing root `data-theme` is retained. The
fallback does not load DaisyUI for pages that do not already include it.
The address bar tracks the active view as `?view=ID`, including a `#fragment`
when navigating to a section. Copy that URL to open the same view and section.
Back and Forward move between views and sections. Fragment links in Markdown and
published HTML stay on the page, even when the HTML uses a `<base href>`.

Published documents and Tasks can link to any hub view with `?view=<id>`
(`diff`, `tasks`, or a published document ID). Diff links reset any narrowed
range to the full stack. To jump to a changed file, use `?view=diff&file=<path>`,
optionally adding `&line=42` or `&line=10-20` and `&side=old` or `&side=new`
(defaulting to the new side, except for deleted files). The diff view expands a
collapsed target file and, when a requested line falls outside the patch hunks,
loads the full file to reveal unchanged context when available. To jump to a
commit in Diff, use `?view=diff&change=<changeId>` with a full change ID or
unique prefix (expanding the commit rail if collapsed). The same links work with
`hub.html?view=...` and as query parameters on the direct Lavish session URL.
Missing, invalid, or ambiguous targets show a notice, and target parameters are
consumed once so refreshing or polling does not jump again.

The hub asks before leaving for a published HTML page when a hub draft or an
unqueued diff comment is unsaved. Published pages similarly ask after user input
or changes outside the navigation. In the in-page confirmation, choose
Keep editing or press Escape to keep the current page and its edits. Choose Leave
page to discard them. If the browser cannot tell whether a slow navigation is still
in progress, the page shows a notice. Select a destination to continue. These guards
do not persist drafts: leaving the page, a browser crash, or forced closure can
discard them. Reverting authored form controls
or `contenteditable` regions to their initial values, or resetting a form, clears
the edited state. Lavish annotation cards do not count as authored edits. Custom
editors that do not emit trusted `input` or `change` events may not be detected, and
a page's own save control leaves the page marked edited unless it resets the form or
updates the control's default.

The diff and Markdown views fetch their renderer the first time they need it,
while the same render reads the document. A loaded renderer stays for the page.
The hub page runs in Lavish's opaque-origin artifact frame and fetches each bundle
from the owner, which grants that read only for a bundle its registration verified.
A server started from a build without that grant cannot serve them, so lavish-hub
refuses to use it rather than let every render fail. The error prints the packaged
CLI's shutdown for the state directory and port this process uses, quoted so it can
be pasted as is; running it shuts that server down, and the next command starts the
current build. Stopping the hub owner does not replace it: the Lavish server it
started keeps running, and the next owner adopts it. A load still incomplete after
ten seconds is cancelled and the view reports the failure with Retry, which asks
for the same bundle again. A partly received bundle never runs.
Export inlines the renderers, so an exported page needs no request for them.

The owner serves files under the published document's directory, including its
subdirectories, but rejects traversal and symlinks outside that directory. Like
Lavish's asset serving, this makes other files in that directory readable to a
reader who has the resource URL: publish from a directory that contains no
unrelated sensitive files. The resource URL has a random per-owner component;
keep it private. It is separate from the action capability and does not authorize
local actions. Published HTML can run scripts and make network requests, so only
publish trusted content. Resources require the running owner and are available
through the same forwarded UI address to remote browsers. Replacing a document
changes its source directory. Published HTML does not currently receive a hub
action SDK.

Run `lavish-hub url [--workspace DIR]` to print the workspace review URL
before or while the owner runs. Before startup, the URL reflects the current port
selection; another process can take that port before the owner starts, so check
again after startup if the URL no longer works. Run `lavish-hub [--workspace DIR]` to check
the owner, add `--view VIEW` to select a built-in view or published document ID,
or run `lavish-hub stop [--workspace DIR]` to request shutdown. Add `--open`
to `lavish-hub` or `publish` to open the existing review (or list
it under Artifacts when available); on `publish`, `--open` also selects the
published document. Plain `publish` leaves the active view unchanged and
prints JSON containing the direct `?view=ID` link. The browser tab title stays
`<title> · Lavish` (or `<repo> · Lavish` when untitled) across view switches. The running owner
remembers the default selection for new tabs (starting on Diff), while an open
tab keeps its own `?view=ID` URL across refreshes. An open hub checks for selection,
repository, and source changes about every two seconds after each completed check;
slow or unavailable actions can delay updates. A read-only check that has not
answered after ten seconds is abandoned, so a stalled owner cannot hold the poll
open; the next check follows after the usual delay.
Polling stops while the tab is hidden and catches up as soon as it is
visible again, on the hub and on published pages, so updates and notifications from
while the tab was hidden appear then. A page that loads in a background tab keeps its first poll so
it has content when it is shown, then waits; that first poll is spent even when it
fails, so a page that never rendered waits for visibility instead of retrying in
the background. Only Diff requests the repository snapshot. The other views poll
selection and document lists alone, and entering Diff asks for a snapshot at
once. If the jj operation is unchanged, the owner reuses its snapshot and sends
only an unchanged reply to a browser that already has it. Use **Refresh** to
rebuild the snapshot and retry any failed range diff even if the operation is
unchanged. If a snapshot fails, the view shows an unavailable notice and retries
on the next poll or when you enter the view again. A status or document check
that fails before the snapshot is requested shows the same notice, and the next
check asks for the snapshot. A tab that goes hidden while that check runs starts
no snapshot and asks when shown again. Re-entering Diff keeps the previous
snapshot on screen (marked as refreshing on the full-stack range bar) until the
new one arrives, and a snapshot that arrives after a page-leaving pause has begun
is kept and shown when that page comes back. Polling preserves a narrowed commit
range until either endpoint disappears from the stack. Clean
Markdown documents update automatically, while unsaved drafts remain in the page.
Published HTML is generated when the owner starts or that document is published;
publishing another document does not rewrite it. Its navigation updates while the
owner is running. Republish after changing its source. An open page without authored
edits reloads automatically, preserving Lavish's scroll position and open annotation
card draft. With unsaved authored edits, it stays in place and shows a green reload
button on the active sidebar entry. Click the button to discard those edits and load
the update, or revert the edits to load it automatically. If a source is unavailable,
the owner leaves its last generated copy in
place and reports the error. It refuses to overwrite a generated copy edited on
disk, including after an abrupt owner termination; preserve or remove that copy
before starting the owner or publishing again. Document registrations are retained
across restarts. Navigating away or reloading resets its internal state. A restarted
owner issues a new access token, so an open hub page or published page that has no
unsaved drafts reloads itself when the owner rejects its token. A hub page with
drafts says to reload instead. The owner
exits on stop, SIGINT, SIGTERM, an ended Lavish session, or a listener error. It
does not start a background daemon. A second owner is refused; an unreachable live
process is not replaced. A stale record is reclaimed only when its recorded process is
provably gone. An incomplete ownership record requires manual investigation;
do not delete it while an owner might still be running.

Diagnostics and the review URL go to stderr. Each feedback batch is one compact
JSON line on stdout with `type: "agent-notification"`, `batchId`, `workspace`,
optional `session`, `instance`, `page`, `prompts`, `hasDomContext`, and `failures`.
When there are no prompts and the snapshot matches a published HTML document,
`snapshotDocument` also identifies its source. Notifications omit the raw DOM
snapshot so stdout stays compact.

Each normalized prompt has a `message` and an `artifact`: a diff (`kind: "diff"`,
`view: "diff"`), a published HTML document (`kind: "document"`, `id`,
`document`), or a hub or freeform message (`kind: "hub"` or `"freeform"`, `view`,
with `id` and `document` when a published document is selected). Diff annotations
include `diff` with `file`, `oldPath`, `side`, `startLine`, `endLine`, and `revision`,
plus `range` and `quote` when the original prefix can be parsed (`revision` and
`range` reflect the selected commit or range when narrowed). Otherwise the
original prompt is retained as `message`. Text annotations include `selection.text`,
and other semantic targets (such as table or Mermaid targets) appear in `target`.
Non-diff element annotations include available `element` fields (`uid`, `tag`,
`selector`, `text`), and nonempty `attachments` are included. Fields whose values
are unavailable may be omitted.

Use `lavish-hub reply --batch ID 'response'` to reply to a particular batch. When
`hasDomContext` is true, `lavish-hub context --batch ID` prints the captured DOM
outline on demand (it prints nothing when none was captured). The running owner
caches the 50 most recent batches in memory and evicts the oldest. Restarting the
owner clears this cache. An unknown or evicted batch reports
`BATCH_CONTEXT_UNAVAILABLE` with `action=refresh`. Add `--workspace DIR` or
`--session ID` to address the right hub. Poll failures are not retried because
delivery may have occurred. See [feedback and actions](feedback-routing.md). An
explicitly ended review needs `--reopen` to open again.

Workspace identity and owner metadata live under the private XDG data directory,
scoped by workspace and Lavish state directory, or by repository, session ID, and
Lavish state directory for session-scoped hubs. The loopback endpoint requires a
per-instance secret; do not share its runtime metadata. If a recorded workspace
is removed, start its owner with the original explicit `--workspace` path to read
surviving registered documents. Unless the hub was targeted to a revision with
`lavish-hub target` before removal, saves and repository actions stay disabled
even if a different checkout later appears at that path, because the hub does
not retarget it automatically.
Sources and HTML resources inside the unavailable workspace cannot be read, even
if replacement files appear there; surviving sources outside it remain readable.
Registrations, metadata, and managed task files persist across owner restarts;
source files are not copied. Keep published sources outside disposable checkouts if
they must remain available. Remove unwanted hub data only after stopping its owner.

The authenticated action endpoint supports `snapshot`, `diffRange`, `diffFiles`,
and `describe` for Diff. A snapshot pins its commit metadata, endpoints, and
full-stack patch to one jj operation (retaining up to 8 recent operations for
unchanged-line reads), while `diffRange` caches up to 32 single-commit or
sub-range patches and file lists pinned to that `operationId`. Viewers share an
owner-side snapshot for up to two seconds, after which Diff polls pick up
external changes. Automatic catch-ups reuse that shared snapshot. The Refresh
button forces a new one there, sharing a refresh already in progress and keeping
that force until it issues a snapshot request, whether or not that request
succeeds. Description
saves invalidate the cached snapshot and check the full change
and commit IDs and expected description, reject missing, divergent, immutable,
or stale changes, and recheck the result. Hub saves are serialized, but other
jj processes do not share that serialization: a small race remains between the
check and `jj describe`. This is not an atomic compare-and-swap. Conflicts return
current visible versions so an editor can preserve the draft and show the change.

