# Files and diagnostics

The hub stores workspace identity, registrations, generated pages, and owner metadata under `${XDG_DATA_HOME:-$HOME/.local/share}/lavish-kit`, scoped by workspace and Lavish state. Lavish uses `${XDG_STATE_HOME:-$HOME/.local/state}/lavish-kit/lavish` by default; `LAVISH_AXI_STATE_DIR` and `LAVISH_AXI_PORT` override the state directory and default port 4388. No old state is migrated.

The foreground owner prints the review URL and diagnostics to stderr and feedback JSON to stdout. Owner runtime metadata contains a per-instance capability: keep it private. Stop the owner before removing its data. A stale owner record is reclaimed only when its process is provably gone; investigate an incomplete record instead of deleting it while an owner might still run. See [hub](hub.md) for source availability and recovery details.

Generated pages and state belong outside the reviewed repository. Source documents are not copied into the hub's persistent registrations; keep them available separately.
