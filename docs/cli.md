# Commands and options

This is the full list of lavish-kit commands, options, output, and exit codes.
`lavish-kit --help` prints a shorter version.

## Commands

```sh
lavish-kit <file.html|file.md|file.markdown> [--title T] [--out FILE] [--open] [--reopen]
lavish-kit diff [-r REV | --from A --to B] [--git] [--title T] [--out FILE] [--open] [--reopen]
lavish-kit diff - [--repo-root DIR] [--title T] [--out FILE] [--open] [--reopen]
lavish-kit task <file.md|file.markdown> [--title T] [--out FILE] [--open] [--reopen]
lavish-kit pr <pr.md|pr.markdown> [-r REV] [--title T] [--out FILE] [--open] [--reopen]
lavish-kit retarget <page.html> [--terminal T]
lavish-kit --help
```

| Command | Opens |
| --- | --- |
| `FILE.html` | The HTML file itself, or a copy at `--out` |
| `FILE.md`, `FILE.markdown` | A read-only rendered page ([markdown.md](markdown.md)) |
| `diff` | A diff page for a jj or git range ([diffs.md](diffs.md)) |
| `diff -` | A diff page for a patch read from stdin, not watched |
| `task FILE` | The Markdown editor for an existing file ([task-documents.md](task-documents.md)) |
| `pr FILE` | A PR draft page, run from the jj repository the PR is for ([pr-drafts.md](pr-drafts.md)) |
| `retarget PAGE` | Nothing. It sends retained feedback to a new herdr terminal ([feedback-routing.md](feedback-routing.md#retarget)) |

File extensions are matched case-insensitively. The source file must exist.

## Options

| Option | Commands | Meaning |
| --- | --- | --- |
| `--title T` | all except `retarget` | Title under herdr's Artifacts and in delivered feedback. Defaults: HTML uses its `<title>`, then the file name. Markdown uses frontmatter `title`, the first H1, then the file name. Task pages use the file name, PR pages `PR: <draft title>`, diffs `Diff review`. |
| `--out FILE` | all except `retarget` | Write the page to FILE instead of the default under `${XDG_DATA_HOME:-$HOME/.local/share}/lavish-kit/pages/`. FILE must be outside the reviewed repository (for `pr`, also outside the repository the command runs in). |
| `--open` | all except `retarget` | Open the URL in a browser (`open` on macOS, `xdg-open` on Linux) if the page wasn't listed under herdr's Artifacts. |
| `--reopen` | all except `retarget` | Reopen a review the user ended. Use it only when they ask. |
| `-r REV` | `diff`, `pr` | `diff`: a jj revset, or an `A..B` range in git. `pr`: the head revision (default `@-`). |
| `--from A --to B` | `diff` | Diff two revisions. Both are required, and they conflict with `-r`. |
| `--git` | `diff` | Use git even inside a jj repository. |
| `-` | `diff` | Read a patch from stdin. Conflicts with `--git`, `-r`, `--from`, and `--to`. |
| `--repo-root DIR` | `diff -` | Directory the patch's paths are relative to (default: the current working directory, not its repository root). Pass the repository root when the patch has repository-relative paths and you run from a subdirectory. |
| `--terminal T` | `retarget` | A live herdr terminal address or unique name to deliver to. |

Each option may be given once.

## Output

Each opening command returns once the page is open in Lavish and its
background worker has started. It prints two lines. The first is one of:

```text
Lavish review of PAGE is listed under the task's Artifacts.
Lavish review of PAGE ready: URL (ask the user to open it)
```

The second says who handles feedback:

```text
Feedback is delivered automatically; do not poll PAGE.
Feedback requires agent polling: lavish-axi poll 'PAGE'.
```

Follow the second line. With automatic delivery, answer with
`lavish-axi reply PAGE --agent-reply '...'` and never poll. With polling, use
`lavish-axi poll`, `reply`, and `end` as with plain Lavish
([feedback-routing.md](feedback-routing.md)).

If the user ended the review, the command prints this instead and opens
nothing:

```text
The user ended the Lavish review of PAGE; pass --reopen only if they ask to see it again.
```

`retarget` prints `Retargeted PAGE to TARGET; delivered N outbox batch(es).`
and, if delivery failed, how many batches remain.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Runtime failure (message on stderr), or `retarget` left batches in the outbox |
| 2 | Usage error. stderr has the reason and the usage summary. |

## Ending a review

End a review with `lavish-axi end PAGE`, or Send & End in the browser. The
worker delivers the final feedback and exits.
