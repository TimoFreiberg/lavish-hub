# PR drafts

This covers `lavish-kit pr FILE`, which edits a PR title and body kept in a
file, and the Create PR button with its `createPr` config. For the hub's direct
save and launch flow, including its fixed submitted revision and launch uncertainty,
see [hub.md](hub.md). Both use the same draft format and `createPr` config.

```sh
lavish-kit pr "$HOME/tasks/example-pr.md" -r @-
```

Run it from the jj repository the PR is for. The draft file can live
elsewhere. `-r` sets the head revision (default `@-`).

## Draft file

The first line is `# <title>` with a nonempty title. Everything after the
first newline is the body, including blank and trailing lines.

```markdown
# Add the document editor

Describe the change here.
```

Opening fails if the draft is malformed, the current directory isn't in a jj
repository, or the head doesn't resolve to exactly one commit.

## The page

The page shows the repository, the head revset and commit ID, the commits from
trunk to head, the source path, a Title field, and the body with Edit and
Rendered tabs. The repository, head, and commit list are captured when the page
opens and don't update. Your PR command may evaluate the revset again when it
runs, so pass an explicit revision if that matters.

The body starts in Rendered view. Page Send, conflicts, disk changes, and limits
work as on [Markdown pages](markdown.md), with three differences: frontmatter
isn't hidden in the preview, an empty title can't be saved, and the saved file
always has a newline after the title line. Page Send and the explicit Create PR
action both send every queued comment. If the file on disk becomes an invalid draft, the
page keeps your edits and says so until the file is fixed.

## Create PR

lavish-kit has no built-in PR command. Configure one in
`${XDG_CONFIG_HOME:-$HOME/.config}/lavish-kit/config.json`:

```json
{
  "createPr": ["fish", "-c", "jprc $argv", "--"]
}
```

`createPr` is an argv array of strings, run without a shell. It must be
nonempty, the first string must name a command, and no string may contain NUL.
This example assumes an existing fish function `jprc` that accepts `-r REV` and
`--body-file FILE` (lavish-kit doesn't provide it). `$argv` forwards the
appended arguments intact.

Without valid config the button is disabled with an explanation naming
`createPr`. Reopen the page after changing the config. The worker also checks
the config again on each Create PR and launches nothing without it.

Create PR only works inside herdr. When pressed, the worker:

1. Saves the draft. A conflict or failed save launches nothing.
2. Appends `-r <recorded rev> --body-file <draft file>` to `createPr`.
3. Opens a new herdr tab named `Create PR` in the herdr space of the delivery
   target, in the recorded repository, running that command (`herdr-app do
   tab.new`).

It never types into the agent's terminal and never falls back to another
space. Continue in the new tab for any interactive steps. A launch reply on the
page doesn't mean a PR exists.

## Create PR failures

| Page reply | What to do |
| --- | --- |
| `Conflict ... Create PR was not launched.` | Resolve with Reload or Keep mine, then press Create PR again. |
| `Create PR failed: ...` naming `createPr` | Fix the config and reopen the page. Nothing was saved. |
| `Create PR failed: the target session or terminal is gone ...` | [Retarget](feedback-routing.md#retarget) the page, then retry. |
| `Create PR failed: ...` (herdr unavailable, no acknowledgement) | Check herdr for a `Create PR` tab before retrying. The save, if reported, stands. |
| `Saved. Create PR launch was interrupted ...` | The worker crashed around the launch and won't launch again. Check herdr before pressing Create PR again. |

Each press is a new launch.

Outside herdr, the action arrives in `lavish-axi poll` output tagged
`lavish-kit-action`. The agent does the save as for task documents and asks
the user to run their PR command
([files-and-logs.md](files-and-logs.md#action-message)).
