# Lavish HTTP boundary

The foreground hub uses the packaged, patched Lavish 0.1.97 runtime. Before use it checks the server health response, version, page-review capability, and canonical state identity. A responding incompatible server on the selected port is rejected rather than replaced. The default is port 4388 and `${XDG_STATE_HOME:-$HOME/.local/state}/lavish-kit/lavish`; `LAVISH_AXI_PORT` and `LAVISH_AXI_STATE_DIR` override them.

The owner is the sole consumer of its page's feedback. A failed consuming poll is not retried because the server may have consumed the batch. See [feedback and actions](feedback-routing.md) and [hub](hub.md) for the observable behavior and delivery guarantees. The package does not provide a general Lavish CLI passthrough.

A server that answers the supported version but lacks one of these capabilities is refused before anything is sent to it. The refusal prints the shutdown that replaces it: the vendored CLI by path, with this process's state directory and port, both quoted so the line can be pasted into a shell.

```sh
LAVISH_AXI_STATE_DIR='<state dir>' LAVISH_AXI_PORT=<port> node '<package>/vendor/lavish/dist/cli.mjs' stop
```

The package installs only `lavish-kit`, so `lavish-axi` is not on `PATH`. A hand-typed `lavish-axi stop` would use the default state directory and port, which reaches a different server or none. To see what a running server actually reports, `curl -s http://127.0.0.1:<port>/health` returns its version and the `lavish_kit_page_reviews` and `lavish_kit_hub_assets` fields the client requires.
