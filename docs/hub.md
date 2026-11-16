# Workspace hub

`lavish-kit hub listen [--workspace DIR] [--open] [--reopen]` runs a foreground
owner for one jj workspace. It opens a stable Lavish page without starting the
standalone feedback relay. The experimental page shows commit descriptions and a
plain-text patch, and provides direct Markdown editors for tasks, PR drafts, and
registered Markdown documents. Description and file saves report conflicts and
keep the draft on the page. Actions require the local owner; if it is unreachable,
the page reports the error without discarding edits. Drafts are not persisted across
page reloads.

## Development prerequisite

The hub uses the patched Lavish 0.1.97 source in `vendor/lavish`, not the
`lavish-axi` executable on `PATH`. From a checkout, install Node 22 or later
and pnpm, then run:

```sh
pnpm --dir vendor/lavish install --frozen-lockfile
pnpm --dir vendor/lavish build
```

Rebuild after changing the vendored source. The built files are not checked in;
a distribution method has not been chosen. The hub checks the server's version,
patch capability, and state directory before polling. A different server on the
configured port may need to be stopped or assigned a different port. Standalone
reviews continue to use the installed `lavish-axi` and their existing 0.1.96
HTTP compatibility requirement.

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
rollback can leave generated pages out of sync. Scope is recorded as supplied, not updated if
commits are rewritten. The displayed scope therefore describes the review at
publication time, not necessarily the current checkout.

Each view has a feedback field. Queue feedback to include the view, the full
revision range at the time you started writing, and any published review scope;
then use Send feedback to deliver queued prompts through the hub's Lavish session.
Draft feedback survives navigation and refresh within the hub page. A browser reload
prompts before discarding unsaved hub drafts; cancel it to keep editing.

Tasks have a checklist and a Markdown source editor; changes are written only when
saved. Published Markdown has Edit and Preview controls; the preview includes
unsaved edits and resolves relative links and images from the source directory.
Published HTML opens as a sibling page in the same Lavish review, where it can
be annotated directly. Scripts, styles, and images resolve relative to its source
file, respecting an authored `<base href>`. Local resources remain restricted to
the source directory as described below. Use the page's hub navigation to open
built-in views or published documents.
Explicit view and publish commands also switch an open published HTML page to the
selected view, unless unsaved edits pause the switch. The hub asks before leaving
for a published HTML page when a hub draft or an unqueued diff comment is unsaved. Published pages similarly
ask after user input or changes outside the navigation, and pause automatic
switches. Cancel the prompt to keep the current page and its edits.
These guards do not persist drafts: accepting a prompt, a browser crash, or forced
closure can discard them. Published pages with custom editors that do not emit
trusted input or change events may not be detected. A published page remains
marked edited even if its own save control has saved the data.

The owner serves files under the published document's directory, including its
subdirectories, but rejects traversal and symlinks outside that directory. Like
Lavish's asset serving, this makes other files in that directory readable to a
reader who has the resource URL: publish from a directory that contains no
unrelated sensitive files. The resource URL has a random per-owner component;
keep it private. It is separate from the action capability and does not authorize
local actions. Published HTML can run scripts and make network requests, so only
publish trusted content. This local resource server requires the owner and a
browser able to reach its loopback address; remote viewers cannot load these
resources. Replacing a document changes its source directory. Published HTML
does not currently receive a hub action SDK.

Run `lavish-kit hub [--workspace DIR]` to check the owner, add `--view VIEW` to
select a built-in view or published document ID, or run `lavish-kit hub stop
[--workspace DIR]` to request shutdown. Add `--open` to the short hub or
`hub publish` command to open the existing review (or list it under Artifacts
when available). Publishing selects the document. Selection
is shared by the running owner and is restored on page refresh; a new owner starts
on Commits. An open hub checks for selection, repository, and source changes about
every two seconds after each completed check; slow or unavailable actions can delay
updates. Clean Markdown documents update automatically, while unsaved drafts remain
in the page. Published HTML is generated when the owner starts or a document is
published; republish after changing its source, then reload the page to see the
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
Registrations, metadata, and managed task and PR files persist across owner restarts;
source files are not copied. Keep published sources outside disposable checkouts if
they must remain available. Remove unwanted hub data only after stopping its owner.

The authenticated action endpoint supports `snapshot` and `describe` for the
workspace views. A snapshot pins its commit metadata, endpoints, patch,
and diff statistics to one jj operation. Description saves check the full change
and commit IDs and expected description, reject missing, divergent, immutable,
or stale changes, and recheck the result. Hub saves are serialized, but other
jj processes do not share that serialization: a small race remains between the
check and `jj describe`. This is not an atomic compare-and-swap. Conflicts return
current visible versions so an editor can preserve the draft and show the change.

Use `lavish-kit hub pr --file FILE` to attach a valid PR draft and `lavish-kit
hub pr --rev REV` to configure its head expression. Both options can be supplied
together; the default head is `@-`. Launch saves the submitted draft first, then
resolves the expression to one full commit ID and passes that ID to the configured
`createPr` command. The receipt shows the submitted ID. With the default head,
a nonempty working copy produces a visible warning and a warning on the owner's
stderr. An explicit head reports whether it is the working-copy commit instead.

The owner rereads `createPr` from the config file on each launch. When the owner
has a live herdr terminal, it attempts to open an interactive tab; otherwise it
shows a quoted command to run manually. A durable request record prevents the
same submission from launching twice. If acknowledgement is lost or the owner
is interrupted, check the terminal before trying again. A successful launch
only opens the command; it does not confirm that a PR was created.
