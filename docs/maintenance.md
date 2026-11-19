# Maintenance watcher

The watcher launches queued workers automatically, one at a time. Workers must
claim their job before working or resuming and report an outcome with
the claim token; blocked outcomes release the slot. Issue workers must use
`check-activity ID TOKEN` to verify current operator activity before acting.
A manually resumed issue worker may use `adopt-activity ID TOKEN` after claiming
to adopt current operator activity and supersede queued versions. A newer answer
may instead launch a fresh worker. Only failed jobs can be explicitly retried.
An uncertain launch must be reconciled
against the named terminal, not retried blindly.
The watcher is run manually; it installs no service. From a terminal inside an
existing herdr core, with `hc`, `herdr-polytoken`, `gh`, `npm`, `jj` and Node on
PATH and authenticated GitHub access, run:

```sh
node scripts/maintenance.mjs once
node scripts/maintenance.mjs watch
node scripts/maintenance.mjs status
node scripts/maintenance.mjs retry JOB_ID
```

The repository defaults to `gh repo view`; set `MAINTENANCE_REPO=owner/repo`
if needed. The operator defaults to the authenticated GitHub user; set
`MAINTENANCE_OPERATOR` to select a different login. Run from the intended
repository. State is under `$XDG_STATE_HOME/lavish-kit/maintenance` (or
`$HOME/.local/state/lavish-kit/maintenance`), shared by its workspaces. It
contains GitHub activity and should be treated as private. Draft state containing
per-job finalizations is not supported: back up and remove `state.json` before
restarting, and manually reconcile any unfinished public actions first. A leftover `lock`
directory requires manual inspection: remove it only after confirming no watcher
or outcome command is running. `status` displays queued jobs, errors, blocked
sessions and launch uncertainties. An uncertain launch cannot be retried: inspect
herdr for the named terminal and run `reconcile` after its state is known.

Issue requests use authenticated conditional GitHub GETs; failures back off.
Dependency checks use npm registry metadata without an LLM and cover direct
`package.json` dependencies and devDependencies plus the pinned `lavish-axi`
runtime version exported by `src/lavish-http.mjs`. The watcher also scans jsDelivr
npm URL pins in `src/markdown.mjs`; other CDN hosts and dynamic URLs are not
covered. Keep the DaisyUI and Tailwind manifest and CDN pins consistent.
Registry checks run daily and compare the latest version, including pinned
versions. Each poll fetches `origin`'s `main` before checking its revision; fetch
failures use the normal backoff. The watcher does not separately track the version
in `vendor/lavish`, poll upstream releases or security advisories, or schedule a
job solely because an advisory appears. Registry checks are not a supply-chain
safety guarantee.

## Vendored Lavish review

For every maintenance assignment, independently check the upstream
[releases](https://github.com/kunchenguid/lavish-axi/releases),
[security advisories](https://github.com/kunchenguid/lavish-axi/security/advisories),
and [npm package](https://www.npmjs.com/package/lavish-axi) for changes relevant to
the vendored version and its use here. Check the vendored dependencies and lockfile
as well as the package itself. Investigate applicability, fixed versions, release
provenance and install scripts before installing a candidate. Record what was
checked, when, and the disposition in the worker's evidence; a failed or incomplete
check is not a clean result. Public sources and dependency audits cannot detect
every vulnerability. Handle sensitive findings privately as directed by the worker
skill.

The import commit `905d0e2f0dbcfb1bb29d65aad90f8b5981a92fa3` identifies the
vendored source as 0.1.97; the upstream
[0.1.97 tag](https://github.com/kunchenguid/lavish-axi/releases/tag/lavish-axi-v0.1.97)
points to `79aa0a18dba9c1a1dcec6db19d2ef4eb7643754b`. The local commit
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
breaks every hub render and nothing else reports it. Its `Vary: Origin` belongs
with it.
Retain or adapt any differences still needed here. Only retire code after establishing an
upstream equivalent and passing the applicable regression tests and full repository
QA, including visual inspection, on the proposed replacement. Review and document
any upgrade separately; this procedure does not itself change the pinned version.

Workers record each candidate with `review-result ID TOKEN NAME VERSION
reviewed|deferred|failed 'evidence'` and separately record a completed sweep with
`sweep-result ID TOKEN`. Deferred and failed versions remain visible in status;
`retry-dependency NAME` explicitly makes one eligible again.

Workers use the existing default facet, model and permissions. They propose a
session goal before working; if goal auto-accept is disabled, an operator must
approve it in the visible terminal. A local smoke test with the default
`herdr-polytoken` configuration verified automatic goal acceptance and completion;
manual approval and other configurations were not verified. The watcher does not
alter the setting or install a wake service. Blocked sessions remain open. Review
and approve agent permissions normally. Issue text is untrusted and cannot
authorize policy or credential access.

Issue workers record `finalization-intent ID TOKEN fix FULL_COMMIT_ID` before
pushing, or `finalization-intent ID TOKEN evidence 'reason and evidence'` for an
already-fixed or obsolete issue. `finalize ID TOKEN` verifies a fix is reachable
from remote main, posts a marked comment, and closes the issue. It persists intent
before each action and reconciles a prior comment or close on retry. Before
resuming, check whether the recorded fix or evidence still resolves the current
request. If not, block for human reconciliation. Otherwise resume the recorded
finalization. For a fix whose recorded commit is not reachable from remote main,
resume integration of that commit rather than implement another fix. A changed
commit requires manual resolution of the recorded intent before pushing.
`issue-comment ID TOKEN 'text'` posts other robot comments with a stable marker.
Both commands check current operator activity before public writes; changed
activity requires a worker to stop and review it. GitHub cannot make this check
atomic with a write, so an operator edit concurrent with a write can still race
it. A leftover lock must be inspected after a crash before resuming. The normal
AGENTS.md integration and QA requirements still apply.
