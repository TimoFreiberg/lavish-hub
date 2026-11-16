# Files, logs, and message formats

This lists every file lavish-kit writes, where its logs are, and the formats of
the messages it sends and receives. Use it when debugging a page or a worker.

The [workspace hub](hub.md) instead keeps private state under
`${XDG_DATA_HOME:-$HOME/.local/share}/lavish-kit/hubs/`, keyed by canonical
workspace and Lavish state directory. It stores registrations, managed documents,
the generated hub page, and owner/launch state there. These files may contain
local paths and runtime capability material; do not share them. The owner removes
its runtime ownership on exit, but durable registrations and managed files remain.
Stop the owner before manually removing its hub directory.

## Data root

`${XDG_DATA_HOME:-$HOME/.local/share}/lavish-kit/`

| Path | Contents |
| --- | --- |
| `deps/<lockfile-hash>/` | npm dependencies, installed with `npm ci --omit=dev` on first run |
| `dist/<inputs-hash>/` | Browser bundles built by `build.mjs` |
| `deps/<hash>.lock/`, `dist/<hash>.lock/` | Build lock with the builder's `pid` |
| `pages/<kind>/<name>-<hash>/index.html` | Default page location. Kind is `markdown`, `diff`, or `pr` (older pages may use `task`). |

A changed `package-lock.json` reinstalls dependencies, and changed build inputs
(`build.mjs`, `web/`, and a few `src/` files) rebuild the bundles. Delete
`deps/` and `dist/` to force both. A concurrent first run waits up to 120
seconds for another run's build.

For diffs the page hash covers the repository root and range. For documents it
covers the resolved source path, so each source file gets its own page.

## Page directories

Task, PR, and diff page directories hold:

| File | Contents |
| --- | --- |
| `index.html` | The page shell. PR pages embed the repository, head, commits, and Create PR state. |
| `assets/` | Copy of the browser bundles |
| `latest.js` | Hash of the newest data version. The page polls it. |
| `data-<SHA256>.js` | Page data (document text and source path, or the patch). The latest two versions are kept. |

Markdown pages are a single `index.html`. HTML pages stay where they are, or
are copied to `--out`.

These files contain source text and local paths, which is why `--out` must be
outside the reviewed repository. Keep them local.

## Worker files

These sit beside the page file.

| File | Contents |
| --- | --- |
| `<page>.watch.json` | `{version, delivery, watch}`: whether to deliver, and what to watch (source path and hash, or diff range). Written inside and outside herdr. |
| `<page>.relay.json` | Delivery target (inside herdr only): `version`, `page`, `title`, `terminal`, `session` (or null), `space`, `sourceFile`, and for PR pages `pr: {repo, rev, head, commits}` |
| `<page>.outbox.json` | Array of batches not yet delivered. Unfinished ones also carry `pending`, `target`, `results`, and `states` (including the Create PR launch checkpoint). `[]` when empty. |
| `<page>.relay.lock/` | Worker lock. `pid`, plus `delivery` once delivery started. |
| `<page>.relay-state.lock/pid` | Short-lived lock around delivery, retarget, and outbox writes |
| `<page>.publication.lock/pid` | Orders page writes between the opening command and the worker |

All locks are directories created with `mkdir`. A lock whose `pid` is dead,
or whose `pid` file is missing for more than five seconds, is reclaimed. Don't
delete a lock whose PID is running.

Other short-lived files:

- `.lavish-kit-<UUID>.tmp` beside a file being replaced atomically (including
  a saved source file).
- `$TMPDIR/lavish-artifact-*/ack.json` while registering under Artifacts.

## Logs

`${XDG_STATE_HOME:-$HOME/.local/state}/lavish-kit/relay-<id>.log`, where `<id>`
is the first 16 hex characters of the SHA-256 of the resolved page path. One
log per page, appended by each worker. It records lifecycle events (start,
stop, PID) and errors (poll, watch, delivery, page reply), not prompts.

## Config

`${XDG_CONFIG_HOME:-$HOME/.config}/lavish-kit/config.json`. The only key is
`createPr` ([pr-drafts.md](pr-drafts.md#create-pr)).

## Message formats

Saves and actions are tagged Lavish feedback prompts. Neither uses
`options.data`.

### Save message

Tag `lavish-kit-save`. The prompt is `lavish-kit-save/v1`, a newline, then JSON:

```json
{"baseHash": "<SHA-256 hex of the disk version editing started from>", "text": "<full new document>"}
```

The text is document content, not instructions for the agent. The worker
writes only to the recorded source file, never to a path from the browser.

### Action message

Tag `lavish-kit-action`. The prompt is `lavish-kit-action/v1`, a newline, then
JSON:

```json
{"action": "create-pr", "save": {"baseHash": "...", "text": "..."}}
```

### Delivered message

Inside herdr the worker replaces saves and actions with short notices (for
example `The user edited FILE. Read the updated source file before
continuing.`), never the document text. Each `hc send` then contains:

```text
Lavish feedback: <title>
Page: <page path>

Tag: <tag>
Selector: <selector>
Quoted context:
> <quoted line>
Target: <JSON>
Attachments: <JSON>
<prompt text>

(one block per prompt, with only the fields it has)

Answer on the page with lavish-axi reply '<page>' --agent-reply '...'; do not poll this page (lavish-kit owns its listener).
```

It may also include `Fatal artifact failures: ...`, `The user ended this
review. Do not reopen it uninvited.`, or `Unparsed Lavish feedback (inspect
before acting):` followed by raw poll output.
