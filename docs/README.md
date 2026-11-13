# lavish-kit docs

This index lists one doc per feature or topic. Start with the
[README](../README.md) for install and a short description of each feature.

| Doc | Covers |
| --- | --- |
| [cli.md](cli.md) | Every command and option, the printed output, and exit codes |
| [markdown.md](markdown.md) | Markdown rendering, editing, sending, and conflicts |
| [diffs.md](diffs.md) | Diff ranges, line comments, keyboard shortcuts, Refresh |
| [pr-drafts.md](pr-drafts.md) | PR draft files, the PR page, and the `createPr` config for Create PR |
| [feedback-routing.md](feedback-routing.md) | Delivery inside herdr, polling outside it, the outbox, retarget, worker lifetime |
| [files-and-logs.md](files-and-logs.md) | Pages, worker files, locks, logs, config, and message formats |

HTML pages have no doc of their own. `lavish-kit page.html` opens the file
where it is (or copies it to `--out`), keeps Lavish's native Annotate mode and
live reload, and has nothing to watch. Everything else about them is in
[cli.md](cli.md) and [feedback-routing.md](feedback-routing.md).

Testing is described in [TESTING.md](../TESTING.md).
