# Command reference

```text
lavish-hub listen [--workspace DIR] [--session ID] [--title TEXT] [--rev REV] [--base REV | --no-base] [--open] [--reopen]
lavish-hub target [REV] [--base REV | --no-base] [--title TEXT] [--session ID] [--workspace DIR]
lavish-hub stop [--workspace DIR] [--session ID]
lavish-hub url [--workspace DIR] [--session ID]
lavish-hub [status] [--workspace DIR] [--session ID] [--open] [--view ID]
lavish-hub publish FILE [--id ID] [--title T] [--metadata-file JSON] [--repo REPO] [--base-commit HEX] [--head-commit HEX] [--source-url URL] [--no-scope] [--workspace DIR] [--session ID] [--attention] [--open]
lavish-hub tasks --file FILE [--workspace DIR] [--session ID]
lavish-hub reply --batch ID [--text | --agent-reply] TEXT [--workspace DIR] [--session ID]
lavish-hub reply PAGE --agent-reply TEXT
lavish-hub context --batch ID [--workspace DIR] [--session ID]
lavish-hub theme [css|syntax|diff-css]
```

`listen` owns a workspace in the foreground; wait until it is ready before using the short commands. `url` prints the workspace review URL without starting an owner or Lavish server. `lavish-hub` and `lavish-hub status` report the owner's status; `lavish-hub --view ID` selects a view. `stop` requests shutdown. `tasks` attaches a task file. `--open` opens an existing review, and `--reopen` permits an explicitly ended review to reopen when starting the owner. `--workspace` selects the jj workspace instead of the current directory.

`--session ID` scopes the hub to the repository and session ID instead of a single workspace. `LAVISH_HUB_SESSION` supplies the ID when the flag is absent, and the flag takes precedence. Multiple sessions can run concurrently against the same repository, and each is addressable from the primary checkout or any child workspace of that repository. IDs start with an ASCII letter or digit and contain up to 128 ASCII letters, digits, `.`, `_`, or `-`. Without either setting, the hub stays scoped to its workspace. Session-scoped `listen` requires a nonempty `--title`, and `target --title TEXT` updates it while the owner runs.

`listen --rev REV` sets the tracked target at startup, and `target [REV]` retargets a running hub. Bookmarks and change IDs follow moves and rewrites. Working-copy expressions such as `@` are resolved in the invoking workspace and pinned to that change so the hub can read it without locking the working copy. A new session with no `--rev` or saved target chooses `@` if it has a description or changes, otherwise `@-` (falling back to `@` if `@-` is `root()`). The target, base, and title persist in `target.json`. `--base REV` sets the base used to find the fork point with the target, and `--no-base` restores the default based on `trunk()` (the two flags are mutually exclusive). `target` updates only the fields supplied and requires at least one.

To keep a workspace-scoped hub usable after deleting its temporary workspace, run `lavish-hub target @` from that workspace before deletion so repository operations move to the primary repository. Files inside the removed or replaced workspace stay blocked, while external documents and managed tasks remain available.

## Publishing

`publish FILE` registers an existing HTML or Markdown file without changing the current view. Omit `--id` to reuse an existing registration for the same canonical file, or derive a stable ID from its filename (see [hub](hub.md) for derivation and collision rules). By default, scope records the repository and the tracked jj target's base and head commits. Use `--no-scope` for an unscoped artifact, or supply `--repo`, `--base-commit`, `--head-commit`, and `--source-url` for explicit scope. `--metadata-file JSON` accepts a JSON object with `reviewedRepository`, `baseCommit`, `headCommit`, and `sourceUrl`, and inline flags override the corresponding file fields. Supplying any inline scope flag or a metadata file disables automatic scope, even if only some fields are supplied. `--no-scope` cannot be combined with either.

The command prints one JSON line with `id`, `url`, `title`, and `scope` (`url` or `scope` can be `null`). `--attention` flags the document in the sidebar until opened, and `--open` selects and opens it. Run `lavish-hub publish --help` for local jj, remote PR, and unscoped examples.

## Feedback

The owner prints each feedback batch as an `agent-notification` JSON line. Use its `batchId` to reply without starting another polling consumer:

```sh
lavish-hub reply --batch BATCH_ID 'Response to the review'
lavish-hub context --batch BATCH_ID
```

`reply` takes one positional text argument or one value after `--text` or `--agent-reply`. Unknown `--` flags are rejected as `USAGE_ERROR`. Pass `--` before a final positional value that starts with `--`, or use `--text` or `--agent-reply`. A successful batch reply prints `{"status":"sent","batchId":"BATCH_ID"}`. It can reach the existing Lavish session even after the owner stops, though if no session exists yet (missing `hub.html`) it fails with `NOT_FOUND` (`action=reconnect`). The legacy form `lavish-hub reply PAGE --agent-reply TEXT` remains available and forwards the packaged Lavish command's exit status or signal.

`context` prints the captured DOM outline for a recent batch from the running owner, or nothing if no outline was captured. Both commands accept `--workspace DIR` and `--session ID` in their batch forms. Run `lavish-hub reply --help` or `lavish-hub context --help` for usage. See [hub](hub.md) for notification fields and cache limits.

## Errors and help

Errors handled by the hub CLI are printed to stderr as `lavish-hub: [<CODE>] action=<action> — <message>`. Each error maps to one recovery action:

| Action | Codes | Recovery |
| --- | --- | --- |
| `reconnect` | `NO_OWNER`, `OWNER_UNREACHABLE`, `LAVISH_CONNECTION_ERROR`, `SESSION_ENDED`, `NOT_FOUND`, `LISTENER_ACTIVE`, `LISTENER_REPLACED`, `UNSUPPORTED_LAVISH`, `LAVISH_STATE_MISMATCH` | Restore the owner or session connection (including missing `hub.html`), or resolve the server mismatch. |
| `refresh` | `WORKSPACE_UNAVAILABLE`, `BATCH_CONTEXT_UNAVAILABLE`, `UNKNOWN_VIEW`, `TARGET_CONFLICT` | Refresh the review, pass explicit scope flags, or resolve the unavailable or changed target. |
| `check_delivery` | `AMBIGUOUS_DELIVERY`, `REPLY_DELIVERY_UNCERTAIN`, `BATCH_ALREADY_REPLIED` | Inspect the review chat before deciding what to do. Do not blindly retry. |
| `retry` | `LAVISH_HTTP_ERROR` | Retry as appropriate. This is also the fallback for unclassified errors. |
| `fix_args` | `USAGE_ERROR`, `VALIDATION_ERROR`, `BATCH_NOT_FOUND` | Fix the arguments, source file, metadata, derived-ID collision, or batch ID. |

`theme` explains how to use Orangebox in standalone HTML. `theme css` prints page and DaisyUI theme CSS, `theme syntax` prints a Shiki-compatible JSON theme, and `theme diff-css` prints Shadow DOM color overrides for `@pierre/diffs`. Include the output in the artifact or its sibling assets; see `theme --help` for setup.

`--help` prints usage. Exit status 0 indicates success, 2 indicates invalid arguments, and 1 indicates a runtime error. Removed standalone commands are not accepted; see [workflow gaps](hub-gaps.md).
