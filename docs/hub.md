# Experimental hub owner

`lavish-kit hub listen [--workspace DIR] [--open] [--reopen]` runs a foreground
owner for one jj workspace. It opens a stable Lavish page without starting the
standalone feedback relay. The experimental page shows commit descriptions and a
plain-text patch, and provides direct Markdown editors for tasks, PR drafts, and
registered Markdown documents. Description and file saves report conflicts and
keep the draft on the page. Actions require the local owner; if it is unreachable,
the page reports the error without discarding edits. Drafts are not persisted across
page reloads.

Each view has a feedback field. Queue feedback to include the view, the full
revision range at the time you started writing, and any published review scope;
then use Send feedback to deliver queued prompts through the hub's Lavish session.
Draft feedback survives navigation and refresh within the page, but not a reload.

This is not the complete hub: the diff is not the standalone annotated diff,
rendered Markdown documents and HTML action integration are not yet available.
Tasks have a checklist and a Markdown source editor; changes are written only when
saved. Published HTML is displayed in a nested sandbox and can load scripts,
styles, and images relative to its source file.

The owner serves files under the published HTML file's directory, including its
subdirectories, but rejects traversal and symlinks outside that directory. Like
Lavish's asset serving, this makes other files in that directory readable to a
reader who has the resource URL: publish from a directory that contains no
unrelated sensitive files. The resource URL has a random per-owner component;
keep it private. It is separate from the action capability and does not authorize
local actions. Published HTML can run scripts and make network requests, so only
publish trusted content. This local resource server requires the owner and a
browser able to reach its loopback address; remote viewers cannot load these
resources. Replacing a document changes its source directory. A nested document
does not currently receive an action SDK, and its annotations are not integrated
with the hub.

Run `lavish-kit hub [--workspace DIR]` to check the owner, add `--view VIEW` to
select a built-in view or published document ID, or run `lavish-kit hub stop
[--workspace DIR]` to request shutdown. Publishing selects the document. Selection
is shared by the running owner and is restored on page refresh; a new owner starts
on Commits. The owner exits on stop, SIGINT,
SIGTERM, an ended Lavish session, or a listener error. It does not start a
background daemon. A second owner is refused; an unreachable live process is
not replaced. A stale record is reclaimed only when its recorded process is
provably gone. An incomplete ownership record requires manual investigation;
do not delete it while an owner might still be running.

Diagnostics and the review URL go to stderr. Each feedback batch is one JSON
line on stdout with `type: "agent-notification"`, `workspace`, `instance`,
`page`, `prompts`, `context`, `failures`, and `reply` fields. Poll failures are
not retried because delivery may have occurred. Reply using the printed Lavish
command. An explicitly ended review needs `--reopen` to open again.

Workspace identity and owner metadata live under the private XDG data directory,
scoped by workspace and Lavish state directory. The loopback endpoint requires a
per-instance secret; do not share its runtime metadata. This experimental owner
is not yet the full hub described in the project plan.

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
