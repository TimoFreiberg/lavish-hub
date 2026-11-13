# Markdown pages

Open an existing UTF-8 `.md` or `.markdown` file for review and editing:

```sh
lavish-kit "$HOME/docs/example.md" --title "Document"
```

The page starts in Rendered view; select Edit to change the text. Rendering uses
markdown-it with links, tables, task lists, raw HTML, heading links and Shiki
syntax highlighting. YAML frontmatter is shown as metadata. Both views support
Lavish annotations.

## Sending edits

Press the page's **Send** button, labelled `(use this instead of sidebar send)`.
It sends the current edit and all queued comments together. The sidebar Send
button does not reliably save edits. The status line distinguishes unsent edits
from the version saved on disk; leaving with unsent edits asks for confirmation.
The immediate sent status is not confirmation of a write: check the Lavish reply.

| Reply | Meaning |
| --- | --- |
| `Saved` | The file was replaced and the agent received a short notice to reread it. |
| `Conflict` | The file changed on disk since editing started; nothing was written. |
| `Save failed: ...` | The message, source, or write failed; nothing was written. |
| `Interrupted save: ...` | The worker crashed during a save and the disk no longer matches. Inspect the file before retrying. |

A save checks the source's SHA-256 against the version editing started from.
If the disk already holds exactly the sent text, it succeeds without writing.
Otherwise replacement is atomic, preserving permissions, though an outside
writer can still change the file between the final check and rename.

The page checks for disk changes every second. With no unsent edits it updates
in place; otherwise it retains your edits and offers Reload (discard mine) or
Keep mine. Send is blocked until you choose. Keep mine makes the next Send
check against the new disk version, so it overwrites the outside change.

## Who writes the file

Inside herdr, the worker writes the file and replies on the page. Outside herdr,
feedback arrives in `lavish-axi poll` as a prompt tagged `lavish-kit-save`;
the receiving agent must compare the file hash, write only if it matches, and
reply `Saved` or `Conflict`. See [files-and-logs.md](files-and-logs.md#save-message).
Opening outside Lavish cannot send. The editor writes UTF-8 with LF newlines;
Lavish 0.1.96 limits one feedback request, including queued comments, to 2 MiB.
