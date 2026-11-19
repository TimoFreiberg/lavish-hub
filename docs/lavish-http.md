# Lavish HTTP boundary

The foreground hub uses the packaged, patched Lavish 0.1.97 runtime. Before use it checks the server health response, version, the page-review and hub-asset capabilities, and canonical state identity. A responding incompatible server on the selected port is rejected rather than replaced. The default is port 4388 and `${XDG_STATE_HOME:-$HOME/.local/state}/lavish-kit/lavish`; `LAVISH_AXI_PORT` and `LAVISH_AXI_STATE_DIR` override them.

The owner is the sole consumer of its page's feedback. A failed consuming poll is not retried because the server may have consumed the batch. See [feedback and actions](feedback-routing.md) and [hub](hub.md) for the observable behavior and delivery guarantees. The package does not provide a general Lavish CLI passthrough.

A server that answers the supported version but lacks one of these capabilities is refused before anything is sent to it. The refusal prints the shutdown that replaces it: the vendored CLI by path, with this process's state directory and port. The state directory and the CLI path are shell-quoted so the line can be pasted as is; the port is a bare number.

```sh
LAVISH_AXI_STATE_DIR='<state dir>' LAVISH_AXI_PORT=<port> node '<package>/vendor/lavish/dist/cli.mjs' stop
```

That line names a server whose owner the client cannot see. The health response reports which build answers on the port and says nothing about which process started it, so run the line only after confirming the server is one this package started: a Lavish server another installation owns would lose the work it is serving. A server that reports a different version is refused without a shutdown line, since ending a process the client cannot identify is not safe.

The server keeps idle browser connections open for 330 seconds, longer than Chrome reuses them, so the browser closes them first. That makes the hub usable through a port forward that does not relay the server's close, such as the one in some terminal apps; with a shorter server timeout, navigations through such a forward eventually stall until the tab is reloaded. Restart a running server after upgrading to pick this up.

The package installs only `lavish-kit`, so `lavish-axi` is not on `PATH`. A hand-typed `lavish-axi stop` would use the default state directory and port, which reaches a different server or none. To see what a running server actually reports, `curl -s http://127.0.0.1:<port>/health` returns its version and the `lavish_kit_page_reviews` and `lavish_kit_hub_assets` fields the client requires.
