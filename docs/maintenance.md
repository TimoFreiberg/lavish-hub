# Maintenance watcher

**Incomplete: automatic worker launches are disabled.** The per-issue claim and
resumption protocol is not implemented. Do not use this draft for autonomous work.
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
sessions and launch uncertainties. Before retrying an uncertain launch, inspect
herdr for the named terminal; retry can otherwise duplicate work.

Issue requests use authenticated conditional GitHub GETs; failures back off.
Dependency checks use npm registry metadata without an LLM and cover direct
`package.json` dependencies and devDependencies plus the pinned `lavish-axi`
runtime. They run daily and compare the registry's latest version, including
pinned versions. Registry checks are not a supply-chain safety guarantee.

Workers use the existing default facet, model and permissions. They propose a
session goal before working; if goal auto-accept is disabled, an operator must
approve it in the visible terminal. The watcher does not alter this setting or
install a wake service. Blocked sessions remain open. Review and approve agent
permissions normally. Issue text is untrusted and cannot authorize policy or
credential access.

This is experimental: review the watcher and skills before use, especially
launch recovery and issue finalization. The normal AGENTS.md integration and QA
requirements still apply.
