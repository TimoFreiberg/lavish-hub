# Command reference

```text
lavish-hub listen [--workspace DIR] [--session ID] [--title TEXT] [--rev REV] [--base REV | --no-base] [--open] [--reopen]
lavish-hub target [REV] [--base REV | --no-base] [--title TEXT] [--session ID] [--workspace DIR]
lavish-hub stop [--workspace DIR] [--session ID]
lavish-hub url [--workspace DIR] [--session ID]
lavish-hub [status] [--workspace DIR] [--session ID] [--open] [--view ID]
lavish-hub publish FILE --id ID [--title T] [--metadata-file JSON] [--workspace DIR] [--session ID] [--attention] [--open]
lavish-hub tasks --file FILE [--workspace DIR] [--session ID]
lavish-hub reply PAGE --agent-reply TEXT
lavish-hub theme [css|syntax|diff-css]
```

`listen` owns a workspace in the foreground; wait until it is ready before using the short commands. `url` prints the workspace review URL without starting an owner or Lavish server. `lavish-hub` and `lavish-hub status` report the owner's status; `lavish-hub --view ID` selects a view. `stop` requests shutdown. `publish` registers an existing HTML or Markdown file without changing the current view and prints its direct `?view=ID` link; `--attention` flags it in the sidebar until opened, and `--open` selects and opens it. `tasks` attaches a task file. `--open` opens an existing review, and `--reopen` permits an explicitly ended review to reopen when starting the owner. `--workspace` selects the jj workspace instead of the current directory.

`--session ID` scopes the hub to the repository and session ID instead of a single workspace. `LAVISH_HUB_SESSION` supplies the ID when the flag is absent, and the flag takes precedence. Multiple sessions can run concurrently against the same repository, and each is addressable from the primary checkout or any child workspace of that repository. IDs start with an ASCII letter or digit and contain up to 128 ASCII letters, digits, `.`, `_`, or `-`. Without either setting, the hub stays scoped to its workspace. Session-scoped `listen` requires a nonempty `--title`, and `target --title TEXT` updates it while the owner runs.

`listen --rev REV` sets the tracked target at startup, and `target [REV]` retargets a running hub. Bookmarks and change IDs follow moves and rewrites. Working-copy expressions such as `@` are resolved in the invoking workspace and pinned to that change so the hub can read it without locking the working copy. A new session with no `--rev` or saved target chooses `@` if it has a description or changes, otherwise `@-` (falling back to `@` if `@-` is `root()`). The target, base, and title persist in `target.json`. `--base REV` sets the base used to find the fork point with the target, and `--no-base` restores the default based on `trunk()` (the two flags are mutually exclusive). `target` updates only the fields supplied and requires at least one.

To keep a workspace-scoped hub usable after deleting its temporary workspace, run `lavish-hub target @` from that workspace before deletion so repository operations move to the primary repository. Files inside the removed or replaced workspace stay blocked, while external documents and managed tasks remain available.

The owner prints each feedback batch as a JSON line with a `reply` command. Replace its placeholder with your response and run it; do not start a second polling consumer. See [hub](hub.md) for document scope, safety, and lifecycle details.

`theme` explains how to use Orangebox in standalone HTML. `theme css` prints page and DaisyUI theme CSS, `theme syntax` prints a Shiki-compatible JSON theme, and `theme diff-css` prints Shadow DOM color overrides for `@pierre/diffs`. Include the output in the artifact or its sibling assets; see `theme --help` for setup.

`--help` prints usage. Exit status 0 indicates success, 2 indicates invalid arguments, and 1 indicates a runtime error. `reply` forwards the packaged Lavish command's exit status or signal. Removed standalone commands are not accepted; see [workflow gaps](hub-gaps.md).
