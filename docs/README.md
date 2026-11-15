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
| [lavish-http.md](lavish-http.md) | Pinned Lavish HTTP contracts, CLI compatibility mode, transport memory measurements |
| [files-and-logs.md](files-and-logs.md) | Pages, worker files, locks, logs, config, and message formats |
| [maintenance.md](maintenance.md) | Manual maintenance watcher and worker sessions |
| [interactive-preview.md](interactive-preview.md) | Local interactive fixture preview and hosting limits |

HTML pages have no doc of their own. `lavish-kit page.html` opens the file
where it is (or copies it to `--out`), keeps Lavish's native Annotate mode and
live reload, and has nothing to watch. Everything else about them is in
[cli.md](cli.md) and [feedback-routing.md](feedback-routing.md).

Pages with their own forms or commenting controls start with Lavish Annotate
mode off and provide a page-level Send button. You can turn Annotate on
manually. Display-only pages retain Lavish's default Annotate behavior.

Generated Markdown, PR, and diff pages use dark mode by default, including
syntax highlighting and native controls, regardless of the operating system
theme. Opening an existing HTML file preserves its authored appearance.

Testing is described in [TESTING.md](../TESTING.md).
