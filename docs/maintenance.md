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
contains GitHub activity and should be treated as private. A leftover `lock`
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
failures use the normal backoff. Registry checks are not a supply-chain safety guarantee.

Workers record each candidate with `review-result ID TOKEN NAME VERSION
reviewed|deferred|failed 'evidence'` and separately record a completed sweep with
`sweep-result ID TOKEN`. Deferred and failed versions remain visible in status;
`retry-dependency NAME` explicitly makes one eligible again.

Workers use the existing default facet, model and permissions. They propose a
session goal before working; if goal auto-accept is disabled, an operator must
approve it in the visible terminal. The watcher does not alter this setting or
install a wake service. Blocked sessions remain open. Review and approve agent
permissions normally. Issue text is untrusted and cannot authorize policy or
credential access.

Issue workers record `finalization-intent ID TOKEN fix FULL_COMMIT_ID` before
pushing, or `finalization-intent ID TOKEN evidence 'reason and evidence'` for an
already-fixed or obsolete issue. `finalize ID TOKEN` verifies a fix is reachable
from remote main, posts a marked comment, and closes the issue. It persists intent
before each action and reconciles a prior comment or close on retry. A retry must
resume the recorded commit rather than implement another fix. A changed commit
requires manual resolution of the recorded intent before pushing. `issue-comment
ID TOKEN 'text'` posts other robot comments with a stable marker. Both commands
check current operator activity before public writes; changed activity requires a
worker to stop and review it. GitHub cannot make this check atomic with a write,
so an operator edit concurrent with a write can still race it. A leftover lock
must be inspected after a crash before resuming. The normal AGENTS.md integration
and QA requirements still apply.
