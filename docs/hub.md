# Workspace hub

`lavish-kit hub listen [--workspace DIR] [--open] [--reopen]` runs a foreground
owner for one jj workspace. It opens a stable Lavish page without starting the
standalone feedback relay. The page shows commit descriptions and an annotated
diff, and provides direct Markdown editors for tasks and
registered Markdown documents. Description and file saves report conflicts and
keep the draft on the page. Actions require the local owner; if it is unreachable,
the page reports the error without discarding edits. Drafts are not persisted across
page reloads.

## Runtime

The package includes patched Lavish 0.1.97 and does not use `lavish-axi` on
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

## Design priorities

Hub design prioritizes the human end-user experience first, system performance
second, and agent experience third; implementation simplicity comes last. Added
complexity is acceptable when it materially supports a higher priority. These
tradeoffs do not relax safety or correctness requirements.

Start the owner in a terminal or a long-running harness job, not inline in a
script that must continue. Wait for its running message before using short
commands; they never start an owner themselves. For example:

```sh
lavish-kit hub listen --workspace "$PWD" --open
# In another terminal, after the owner is ready:
lavish-kit hub publish "$HOME/reviews/review.html" --id review --title "Review" --metadata-file "$HOME/reviews/scope.json" --open
lavish-kit hub --view review
lavish-kit hub stop
```

The source must already exist and end in `.html`, `.md`, or `.markdown`. IDs
are 1–64 ASCII letters, digits, underscores or hyphens, starting with a letter
or digit; built-in view IDs are reserved. Publishing an existing ID replaces its
registration and selects it. `--metadata-file` accepts a JSON object of at most
16 KiB with optional `reviewedRepository` (nonempty display name), `baseCommit`
and `headCommit` (full 40- or 64-digit hex IDs), and `sourceUrl` (HTTP(S) URL).
Unknown fields are rejected. Each publication replaces all previous metadata;
omitting it clears the old scope. If generating the published HTML pages fails,
publication retains the previous registration, metadata, selection, and generated
pages when rollback succeeds. A process interruption or filesystem error during
rollback can leave generated pages out of sync. Scope is recorded as supplied and
is not updated if commits are rewritten. The displayed scope describes the review
at publication time, not necessarily the current checkout.

Entering Commits or Changes turns Lavish annotations off so you can interact
with the view. Turn the annotation switch back on whenever you want to comment
there. Entering another view turns annotations on. Refreshing the current view
does not change your choice. A browser reload prompts before discarding
unsaved hub drafts; cancel it to keep editing.

Commits shows each description and its own diff statistics. Use the pencil button
to edit a description; Cancel or Escape discards the edit. Descriptions and
statistics that exceed their initial height scroll and can be resized vertically.
A failed save keeps the draft and shows the error beside the Save button.

Tasks display rendered Markdown with interactive checkboxes. Toggling a checkbox
saves it immediately; while saving, the other checkboxes are disabled. If saving
fails, the source editor opens with the draft and an error. Use the pencil to edit
the source of Tasks or published Markdown, then Save or discard with Cancel or
Escape. Published Markdown resolves relative links and images from its source
directory. Diff comments enter the Lavish sidebar queue; send them from the sidebar.
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
Explicit view and publish commands also switch an open published HTML page to the
selected view, unless unsaved edits pause the switch. The hub asks before leaving
for a published HTML page when a hub draft or an unqueued diff comment is
unsaved. Published pages similarly ask after user input or changes outside the
navigation, and pause automatic switches. In the in-page confirmation, choose
Keep editing or press Escape to keep the current page and its edits. Choose Leave
page to discard them. These guards do not persist drafts: leaving the page, a
browser crash, or forced closure can discard them. Published pages with custom
editors that do not emit trusted input or change events may not be detected. A
published page remains marked edited even if its own save control has saved the
data.

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

Run `lavish-kit hub url [--workspace DIR]` to print the workspace review URL
before or while the owner runs. Run `lavish-kit hub [--workspace DIR]` to check
the owner, add `--view VIEW` to select a built-in view or published document ID,
or run `lavish-kit hub stop [--workspace DIR]` to request shutdown. Add `--open`
to the short hub or `hub publish` command to open the existing review (or list
it under Artifacts when available). Publishing selects the document. Selection
is shared by the running owner and is restored on page refresh; a new owner starts
on Commits. An open hub checks for selection, repository, and source changes about
every two seconds after each completed check; slow or unavailable actions can delay
updates. Clean Markdown documents update automatically, while unsaved drafts remain
in the page. Published HTML is generated when the owner starts or that document is
published; publishing another document does not rewrite it. Its navigation updates
while the owner is running. Republish after changing its source, then reload to see the
new version. If a source is unavailable, the owner leaves its last generated copy
in place and reports the error. It refuses to overwrite a generated copy edited on
disk, including after an abrupt owner termination; preserve or remove that copy
before starting the owner or publishing again. Document registrations are retained
across restarts. Navigating away or
reloading resets its internal state. The owner exits on stop, SIGINT,
SIGTERM, an ended Lavish session, or a listener error. It does not start a
background daemon. A second owner is refused; an unreachable live process is
not replaced. A stale record is reclaimed only when its recorded process is
provably gone. An incomplete ownership record requires manual investigation;
do not delete it while an owner might still be running.

Diagnostics and the review URL go to stderr. Each feedback batch is one JSON
line on stdout with `type: "agent-notification"`, `workspace`, `instance`,
`page`, `prompts`, `context`, `snapshotPage`, `snapshotDocument`, `failures`,
and `reply` fields. For a published HTML document, each annotation prompt has a
`document` source path; `snapshotDocument` identifies the source of the snapshot,
while `snapshotPage` retains Lavish's page identity. The snapshot document is null
when no published HTML source matches. Poll failures are not retried because delivery may have occurred. Reply using the printed Lavish
command. An explicitly ended review needs `--reopen` to open again.

Workspace identity and owner metadata live under the private XDG data directory,
scoped by workspace and Lavish state directory. The loopback endpoint requires a
per-instance secret; do not share its runtime metadata. If a recorded workspace
is removed, start its owner with the original explicit `--workspace` path to read
surviving registered documents. Saves and repository actions remain disabled, including if
a different checkout later appears at that path; the hub does not retarget it.
Sources and HTML resources inside the unavailable workspace cannot be read, even
if replacement files appear there; surviving sources outside it remain readable.
Registrations, metadata, and managed task files persist across owner restarts;
source files are not copied. Keep published sources outside disposable checkouts if
they must remain available. Remove unwanted hub data only after stopping its owner.

The authenticated action endpoint supports `snapshot` and `describe` for the
workspace views. A snapshot pins its commit metadata, endpoints, patch,
and diff statistics to one jj operation. Viewers share an owner-side snapshot for
up to two seconds; automatic refreshes then pick up external changes. The Refresh
button requests a new snapshot, sharing a refresh already in progress. Description
saves invalidate the cached snapshot and check the full change
and commit IDs and expected description, reject missing, divergent, immutable,
or stale changes, and recheck the result. Hub saves are serialized, but other
jj processes do not share that serialization: a small race remains between the
check and `jj describe`. This is not an atomic compare-and-swap. Conflicts return
current visible versions so an editor can preserve the draft and show the change.

