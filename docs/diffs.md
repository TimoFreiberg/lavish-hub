# Diff pages

This covers `lavish-kit diff`, which shows a jj or git diff as a Lavish page
with line comments.

The page and syntax highlighting default to dark mode. Unchanged lines outside
the supplied patch context are not yet expandable; see issue #2.

```sh
lavish-kit diff                    # jj: fork_point(trunk() | @) to @
lavish-kit diff -r @-
lavish-kit diff --from A --to B
lavish-kit diff --git              # use git inside a jj repository
jj diff --git | lavish-kit diff - --repo-root "$PWD"
```

## Ranges

Run it inside the repository. jj is used when `jj root` succeeds, unless
`--git` is given.

| | jj | git |
| --- | --- | --- |
| Default | `fork_point(trunk() \| @)` to `@` | Working tree against its merge base with the first of `origin/HEAD`, `origin/main`, `origin/master`, `main`, `master` that has one |
| `-r REV` | Any revset | Must be `A..B` |
| `--from A --to B` | Two revisions | Two revisions |

`diff -` reads a patch from stdin. `--repo-root DIR` sets the directory its
paths are relative to. A stdin patch is a snapshot and is never updated.

## Commenting

Diff pages start with Lavish's own Annotate mode off, because Lavish's
annotations would see the diff renderer's container rather than the clicked
line. Click a code line, or select a range in the line-number gutter, to open a
comment box beside it. Queue comment (Cmd+Enter) adds it to Lavish's queue
with the path, old or new side, revision, and quoted source lines. Lavish's
Send delivers the queue.

## Keyboard

| Key | Action |
| --- | --- |
| `j` / `k` | Next / previous file |
| `n` / `p` | Next / previous hunk |
| `v` | Toggle viewed on the current file |
| `s` | Toggle split view |
| `?` | Show or hide help |

## Refresh

The worker re-reads jj and git diffs every second (for jj, only when the
range's commit IDs change) and publishes a new version beside the page. The
page checks every two seconds. When the diff changed, it shows
`Diff changed` and a Refresh button that loads the new version in place.
Refresh is disabled while a comment box has text, so queue or cancel the
comment first.

The default page path is
`${XDG_DATA_HOME:-$HOME/.local/share}/lavish-kit/pages/diff/<repo>-<hash>/index.html`,
where the hash covers the repository and range.
