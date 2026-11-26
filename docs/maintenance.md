# Vendored Lavish maintenance

When reviewing or upgrading vendored Lavish, independently check the upstream
[releases](https://github.com/kunchenguid/lavish-axi/releases),
[security advisories](https://github.com/kunchenguid/lavish-axi/security/advisories),
and [npm package](https://www.npmjs.com/package/lavish-axi) for changes relevant to
the vendored version and its use here. Check the vendored dependencies and lockfile
as well as the package itself. Investigate applicability, fixed versions, release
provenance and install scripts before installing a candidate. Public sources and
dependency audits cannot detect every vulnerability.

The import commit `905d0e2f0dbcfb1bb29d65aad90f8b5981a92fa3` identifies the
vendored source as 0.1.97; the upstream
[0.1.97 tag](https://github.com/kunchenguid/lavish-axi/releases/tag/lavish-axi-v0.1.97)
points to `79aa0a18dba9c1a1dcec6db19d2ef4eb7643754b`. Vendored source was later
bumped to [0.1.98](https://github.com/kunchenguid/lavish-axi/releases/tag/lavish-axi-v0.1.98)
while retaining the local patches. The local commit
`70cb1ada946b295b24481bb2d14d56405cab8d31` ports page-scoped reviews from
[upstream PR 363](https://github.com/kunchenguid/lavish-axi/pull/363); later local
changes also touch the vendored source. These identifiers describe the recorded
history, not a byte-for-byte verification of the import or an assertion that the
local patch matches the PR's current head.

Do not remove the patch just because the PR merges or a new version appears.
Compare the candidate release's actual source and behavior with the local patch and
later changes, including page-scoped feedback, routing and hub integration. The
local `window.lavish.setAnnotationMode(boolean)` addition requests a chrome switch
change over the authenticated artifact protocol and resolves on acknowledgment or
returns false after one second. The `lavish:ready` event signals SDK availability.
The hub uses these on view transitions. The `Access-Control-Allow-Origin: null`
grant on a verified `hub-asset-<hash>.js` representation in the vendored artifact
route is a local difference of the same kind: the hub page fetches its renderer
bundles from the opaque-origin artifact frame, so a candidate that drops the grant
serves a hub whose renderers cannot load. Keep its `Vary: Origin` and the
`lavish_hub_assets` field its `/health` reports. The release number stays
upstream's, so only that field lets a lavish-hub process recognize a server built
without the grant, including one still running from an earlier build of the same
release, and refuse it. Closing the connection after every HTTP response, and the
heartbeat message on live-event WebSockets with the chrome's silence check, are
further local differences: upstream reuses connections, which stalls the hub behind
a port forward that does not relay the server's close. Direct session links also
rely on local `initialViewParams` validation in `server.js` (`file`, `line`,
`side`, and `change`, paired with `view`) and one-shot `__lavish_hub_*`
forwarding in `chrome-client.js`. The chrome strips those parameters from stored
destinations and the outer URL after forwarding them to the artifact frame.

The batch-reply patch returns `batch_id` on consuming polls and accepts it on
`POST /api/:key/agent-reply`, binding `Done` receipts to that batch (while unbound
replies still stamp all open delivered prompts and mark their batches replied). The
endpoint returns `404 BATCH_NOT_FOUND` for an unknown batch and
`409 BATCH_ALREADY_REPLIED` with `replied_at` for a duplicate. The client requires
`lavish_hub_batch_replies: 1` on `/health` to distinguish a server with this patch
from an older build of the same version. Preserve the capability check,
disconnected-poll restore, bounded batch records, and receipt isolation when
evaluating an upgrade. See [the HTTP boundary](lavish-http.md#batch-replies) and
[feedback and actions](feedback-routing.md#delivery-guarantees).

Retain or adapt any differences still needed here. Only retire code after establishing an
upstream equivalent and passing the applicable regression tests and full repository
QA, including visual inspection, on the proposed replacement. Review and document
any upgrade separately; this procedure does not itself change the pinned version.
