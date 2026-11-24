# Lavish HTTP boundary

The foreground hub uses the packaged, patched Lavish 0.1.98 runtime. Before use it checks the server health response, version, the page-review and hub-asset capabilities, and canonical state identity. The default state directory is `${XDG_STATE_HOME:-$HOME/.local/state}/lavish-hub/lavish`; `LAVISH_AXI_STATE_DIR` overrides it.

Without `LAVISH_AXI_PORT`, commands find an existing Lavish server for that state directory on ports 4388–4407, or choose the first available port in that range. Unidentified listeners on unrecorded ports are skipped. If the recorded port is occupied but its listener cannot identify itself, startup is refused rather than risking a second server writing the same state. A matching but incompatible server is rejected rather than replaced. An explicit `LAVISH_AXI_PORT` selects exactly that port, with no fallback, and is rejected if another known port uses the same state.

Startup and discovery are serialized by `port-start.lock` in the state directory. `port.json` records the selected port before startup so later commands can find even an explicit port. If a startup process is killed, the lock can remain; after confirming no Lavish Hub startup is in progress, remove the lock directory and retry. If another listener takes the selected port during launch, the recorded port can remain ambiguous. Stop that listener and confirm no Lavish server is starting or running for the state directory before removing `port.json` and retrying. Servers started independently outside the default range and without a port record cannot be discovered. An unrecorded server that cannot report its state identity is also indistinguishable from an unrelated listener, so stop older or independently started servers before using the same state directory.

HTTP connection failures with a network error code report the loopback address and suggest checking the server and `LAVISH_AXI_PORT`.

The owner is the sole consumer of its page's feedback. A failed consuming poll is not retried because the server may have consumed the batch. See [feedback and actions](feedback-routing.md) and [hub](hub.md) for the observable behavior and delivery guarantees. The package does not provide a general Lavish CLI passthrough.

A server that answers the supported version but lacks one of these capabilities is refused before anything is sent to it. The refusal prints the shutdown that replaces it: the vendored CLI by path, with this process's state directory and port. The state directory and the CLI path are shell-quoted so the line can be pasted as is; the port is a bare number.

```sh
LAVISH_AXI_STATE_DIR='<state dir>' LAVISH_AXI_PORT=<port> node '<package>/vendor/lavish/dist/cli.mjs' stop
```

That line names a server whose owner the client cannot see. The health response reports which build answers on the port and says nothing about which process started it, so run the line only after confirming the server is one this package started: a Lavish server another installation owns would lose the work it is serving. A server that reports a different version is refused without a shutdown line, since ending a process the client cannot identify is not safe.

Every HTTP response closes its connection, so the browser opens a new one for each request instead of reusing an old one. That keeps the hub usable through a port forward that does not relay the server's close, such as the one in some terminal apps. Through such a forward, a connection the server had closed looked open to the browser, and requests sent on it were never answered until navigations stalled and the tab had to be reloaded. The live-event WebSocket carries a heartbeat message every 30 seconds; a page that hears nothing for 75 seconds replaces the connection. Restart a running server after upgrading to pick this up.

The package installs only `lavish-hub`, so `lavish-axi` is not on `PATH`. A hand-typed `lavish-axi stop` would use the default state directory and port, which reaches a different server or none. To see what a running server actually reports, `curl -s http://127.0.0.1:<port>/health` returns its version and the `lavish_hub_page_reviews` and `lavish_hub_assets` fields the client requires.
