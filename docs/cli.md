# Command reference

```text
lavish-kit hub [listen|stop|status] [--workspace DIR] [--open] [--reopen]
lavish-kit hub publish FILE --id ID [--title T] [--metadata-file JSON] [--workspace DIR] [--open]
lavish-kit hub tasks --file FILE [--workspace DIR]
lavish-kit hub pr [--file FILE] [--rev REV] [--workspace DIR]
lavish-kit reply PAGE --agent-reply TEXT
```

`hub listen` owns a workspace in the foreground; wait until it is ready before using the short commands. `hub` and `hub status` report its status; `hub --view ID` selects a view. `hub stop` requests shutdown. `publish` registers an existing HTML or Markdown file, `tasks` attaches a task file, and `pr` configures a PR draft or revision. `--open` opens an existing review, and `--reopen` permits an explicitly ended review to reopen when starting the owner. `--workspace` selects the jj workspace instead of the current directory.

The owner prints each feedback batch as a JSON line with a `reply` command. Replace its placeholder with your response and run it; do not start a second polling consumer. See [hub](hub.md) for document scope, safety, and lifecycle details.

`--help` prints usage. Exit status 0 indicates success, 2 indicates invalid arguments, and 1 indicates a runtime error. `reply` forwards the packaged Lavish command's exit status or signal. Removed standalone commands are not accepted; see [workflow gaps](hub-gaps.md).
