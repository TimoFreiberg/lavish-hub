# Experimental hub owner

`lavish-kit hub listen [--workspace DIR] [--open] [--reopen]` runs a foreground
owner for one jj workspace. It opens a stable Lavish page without starting the
standalone feedback relay. The experimental page shows commit descriptions and a
plain-text patch, and provides direct Markdown editors for tasks, PR drafts, and
registered Markdown documents. Description and file saves report conflicts and
keep the draft on the page. Actions require the local owner; if it is unreachable,
the page reports the error without discarding edits. Drafts are not persisted across
page reloads.

This is not the complete hub: the diff is not the standalone annotated diff,
tasks have only a source editor, and PR launch, rendered published documents, HTML
assets and actions, feedback context, and shared navigation are not yet available.
The registered HTML source is not displayed by this version.

Run `lavish-kit hub [--workspace DIR]` to check the owner or `lavish-kit hub
stop [--workspace DIR]` to request shutdown. The owner exits on stop, SIGINT,
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
