# Lavish transport

The shared relay uses direct HTTP instead of retaining a `lavish-axi` Node
process for each poll or spawning one for every watch-only status check.
Opening reviews and manual `lavish-axi` commands still use the CLI. Retarget's
infrequent reply also keeps its existing CLI path.

This adapter supports exactly **lavish-axi 0.1.96**. The contracts below were
checked in its installed `dist/cli.mjs`, rather than inferred from browser
requests. The private API is small enough to integrate; private status alone
is not a reason to defer the optimization.

| Operation | Verified contract |
| --- | --- |
| Identify server | `GET /health`: require `ok`, `app=lavish-axi`, version, and `state_id` matching the canonical state file |
| Poll | `GET /api/poll?file=…&owner=…`; exclusive ownership, no takeover, whitespace heartbeat before the final JSON body |
| Conflicting listener | HTTP 409 with `LISTENER_ACTIVE`; back off without replacing the holder |
| Replaced listener | JSON with `LISTENER_REPLACED`; stop |
| Reply | `POST /api/:key/agent-reply` with `{text}`; key is the first 16 hex characters of SHA-256 of the canonical page path |
| End | `POST /api/end` with `{file}`; preserve agent-ended semantics |
| List sessions | No HTTP endpoint exists in this version. Read `state.json` without mutation, as the no-argument CLI does |

The default state directory is `$HOME/.lavish-axi`, overridden by
`LAVISH_AXI_STATE_DIR`. Loopback uses `LAVISH_AXI_PORT`, default 4387. Lavish
always provides its local loopback listener even when its browser links use a
different configured address. The adapter neither starts a server nor changes
its exposure.

Raw JSON is mapped into the relay's existing session/prompts/failures shape.
The existing outbox, receipt targets, emergency persistence, handler recovery,
and Create PR launch records are unchanged. There is no automatic retry of a
consuming request after transport or JSON errors. A broken response may already
have consumed feedback, just as with CLI polling; the relay stops and logs the
unknown outcome. Aborting the worker aborts its HTTP request as well.

`test/lavish-http.test.mjs` checks version/state mismatches before polling,
truncated responses without retries, feedback fields, non-consuming listings,
and a real server's exclusive listener, prompt delivery, reply and end routes.
It needs the pinned `lavish-axi` executable, but no browser or herdr.

## Measure memory

Run `node scripts/measure-lavish.mjs` with Lavish 0.1.96 on PATH. It compares
1, 5, and 20 simultaneous CLI and HTTP polls in fresh private servers and
prints RSS totals in MiB. Totals include the measurement process, Lavish, and
every CLI poll child. Each scenario closes only its own sessions and children.

Measured on Linux with Node 24.22.1 and Lavish 0.1.96:

| Pages | CLI total MiB | HTTP total MiB | CLI processes | HTTP processes |
| --- | ---: | ---: | ---: | ---: |
| 1 | 179.9 | 117.6 | 3 | 2 |
| 5 | 424.9 | 118.7 | 7 | 2 |
| 20 | 1343.9 | 123.4 | 22 | 2 |

At 20 pages, removing the retained CLI processes saved about 1.2 GiB in this
fixture. RSS is a point-in-time sum, includes shared pages in each process,
and varies across platforms and runs; it is not unique physical memory.

The 20-page scenarios also report server RSS one second after ending 19 pages
while keeping one open. In a separate HTTP run the server measured 64.1 MiB
before and 66.1 MiB afterward. There was no immediate RSS reduction. Ending
the final page stopped the server. This short empty-page fixture cannot
distinguish reusable heap from retained session data or establish a leak.

This is a **transport-only** measurement. It does not include a herdr process,
review browser, real relay daemon, renderers, or realistic artifact histories.
It cannot establish a 50–70 MB whole-application target or prove that long-lived
Lavish releases memory after stale sessions end. Those need a working herdr
and browser environment and a separate long-running measurement.
