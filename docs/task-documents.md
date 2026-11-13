# Task documents

This covers `lavish-kit task FILE`, the in-browser editor for an existing
Markdown file.

```sh
lavish-kit task "$HOME/tasks/example.md" --title "Task document"
```

FILE must be an existing UTF-8 `.md` or `.markdown` file.

## The page

The page has Edit and Rendered tabs. Edit is a plain text area. Rendered shows
a preview with links, tables, task lists, and raw HTML, without the
frontmatter and without syntax highlighting. Both views support Lavish's native
annotations. A status line under the tabs shows the current state, for example
`Unsaved edits` or `Up to date with disk`.

## Saving

Press Save, or Cmd+S (Ctrl+S on Linux).

Save sends the new text through Lavish's send. That also sends every comment
you have queued on the page, so queue comments after saving if you don't want
them sent yet.

The page shows `Save sent` right away. The result arrives as a Lavish reply on
the page:

| Reply | Meaning |
| --- | --- |
| `Saved` | The file was replaced. The agent got a short notice to reread it (never the contents). |
| `Conflict` | The file changed on disk since editing started. Nothing was written. |
| `Save failed: ...` | The message was malformed, the source is gone or unreadable, or the write failed. Nothing was written. |
| `Interrupted save: ...` | The worker crashed during a save and the disk no longer matches. Inspect the file before saving again. |

A save writes only if the file still matches the version editing started from
(by SHA-256). If the disk already holds exactly the saved text, the save
succeeds without writing. The file is replaced atomically through a temporary
`.lavish-kit-<UUID>.tmp` beside it, with its permissions kept. A writer outside
lavish-kit can still change the file between the last check and the rename.

Opened outside Lavish, Save shows `Save unavailable: open this page in Lavish`.
Leaving the page with unsaved edits asks for confirmation.

## When the file changes on disk

The page checks for a new version every second.

- Without unsaved edits, the editor updates in place.
- With unsaved edits, it keeps them and shows Reload (discard mine) and Keep
  mine. Save is blocked until you pick one. Keep mine makes the next Save
  check against the new disk version, so it overwrites the outside change.

After a `Conflict` or `Interrupted save`, check the file and your edits, then
pick Reload or Keep mine before saving again.

## Who writes the file

Inside herdr, the worker writes the file and replies on the page. Outside
herdr, nobody does that automatically: the save arrives in `lavish-axi poll`
output as a prompt tagged `lavish-kit-save`. The agent then compares the
file's SHA-256 with `baseHash`, writes `text` only if they match, and replies
`Saved` or `Conflict` on the page. The format is in
[files-and-logs.md](files-and-logs.md#save-message).

## Limits

- The editor saves UTF-8 with LF newlines.
- Lavish 0.1.96 caps one feedback request at 2 MiB, including escaped text and
  queued comments, so larger documents can't be saved.
