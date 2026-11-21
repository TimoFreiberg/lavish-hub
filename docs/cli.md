# Command reference

```text
lavish-kit hub listen [--workspace DIR] [--open] [--reopen]
lavish-kit hub stop [--workspace DIR]
lavish-kit hub url [--workspace DIR]
lavish-kit hub [status] [--workspace DIR] [--open] [--view ID]
lavish-kit hub publish FILE --id ID [--title T] [--metadata-file JSON] [--workspace DIR] [--attention] [--open]
lavish-kit hub tasks --file FILE [--workspace DIR]
lavish-kit reply PAGE --agent-reply TEXT
lavish-kit theme [css|syntax|diff-css]
```

`hub listen` owns a workspace in the foreground; wait until it is ready before using the short commands. `hub url` prints the workspace review URL without starting an owner or Lavish server. `hub` and `hub status` report the owner's status; `hub --view ID` selects a view. `hub stop` requests shutdown. `publish` registers an existing HTML or Markdown file without changing the current view and prints its direct `?view=ID` link; `--attention` flags it in the sidebar until opened, and `--open` selects and opens it. `tasks` attaches a task file. `--open` opens an existing review, and `--reopen` permits an explicitly ended review to reopen when starting the owner. `--workspace` selects the jj workspace instead of the current directory.

The owner prints each feedback batch as a JSON line with a `reply` command. Replace its placeholder with your response and run it; do not start a second polling consumer. See [hub](hub.md) for document scope, safety, and lifecycle details.

`theme` explains how to use Orangebox in standalone HTML. `theme css` prints page and DaisyUI theme CSS, `theme syntax` prints a Shiki-compatible JSON theme, and `theme diff-css` prints Shadow DOM color overrides for `@pierre/diffs`. Include the output in the artifact or its sibling assets; see `theme --help` for setup.

`--help` prints usage. Exit status 0 indicates success, 2 indicates invalid arguments, and 1 indicates a runtime error. `reply` forwards the packaged Lavish command's exit status or signal. Removed standalone commands are not accepted; see [workflow gaps](hub-gaps.md).
