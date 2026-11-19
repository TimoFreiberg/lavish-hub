# Testing lavish-kit

This describes `just check`, the standalone test commands, their requirements,
and known flaky tests.

Besides the runtime requirements in the [README](README.md), the tests need
`just`, fish, ripgrep, and Playwright's cached Chromium. Set
`LAVISH_KIT_CHROMIUM` to use another Chromium executable.

## Fixture preview

Run `just preview` to generate a local, read-only development preview in the
ignored `preview/` directory, or `just preview /path/to/empty-directory` to
choose an empty output directory. Serve that directory with a static HTTP server;
`file://` is not supported. The index and manifest record the actual working
revision and build time, not a published main revision. `SOURCE_DATE_EPOCH` sets
the timestamp for reproducible tests. Saves and comments are simulated
in disposable page memory; reload or navigation discards changes. See the
[preview guide](docs/interactive-preview.md) for controls and hosting limits.
Nothing is published. Do not overlap `just preview` with other commands that
install dependencies in this checkout.

## Demo hub

Run `just demo` to see the real hub with realistic data. It rebuilds `dist/`,
creates a jj repository and review documents in
`${XDG_CACHE_HOME:-$HOME/.cache}/lavish-kit-demo`, and runs a hub on port 4399
with its own XDG and Lavish state, so your normal hub is not affected. Each run
deletes and recreates that directory. Restart it to pick up code changes. Stop
it with Ctrl-C or `just demo-stop`. Use `--dir`, `--port` and `--no-open` to
change the defaults.

To investigate action timeouts, rebuild the vendored server with
`node scripts/prepare-check.mjs`, then start a fresh demo with
`LAVISH_HUB_DIAGNOSTICS=1 just demo` and capture the terminal's stderr. The
proxy writes its diagnostics to
`${XDG_CACHE_HOME:-$HOME/.cache}/lavish-kit-demo/state/lavish/server.log`
(or `state/lavish/server.log` under a custom demo directory). Collect lines
containing `"diagnostic":"hub"` from both places after reproducing the issue;
other output may contain private data. The flag must be present when both
processes start, so an existing demo needs a restart. Unset it on the next
start to disable logging.

Each diagnostic record is JSON containing UTC time, elapsed milliseconds, method,
status where available, and a process-local request number. In the detached
server's `server.log`, a separate UTC timestamp and space precede the JSON; strip
that prefix before parsing the record as JSON. Numbers are not shared across
proxy and owner; compare timestamps to relate requests. `arrive` marks receipt,
`forward` means the proxy has authenticated the owner and is about to send the
request, and `upstream-response`, `finish`, and `close` mark later stages. The
proxy handles preflight itself, so an OPTIONS request need not reach the owner.
A `close` without `finish` indicates an interrupted response. Server-side lines
also cover all HTTP methods and use fixed route classes: `proxy-action`,
`proxy-resource`, `artifact-page`, `artifact-asset`, and `other`. These classes
are based on the request shape, not the eventual handler; an unusual artifact
filename may be classified differently from how it is served. Server `arrive`
precedes the host check. `lookup-start` and `lookup-end` surround session lookup
for proxy requests and path-addressed artifacts when those requests reach that
step. A missing end can indicate a pending lookup, a lookup failure, a closed
connection, or a dropped log line. Other work, including compression, has no
individual phase markers. A request with arrival but no later line may still be
pending, but cannot locate the delay precisely. Logs are best effort. The server
request logger drops lines under stderr backpressure. The existing proxy and
owner console writers do not apply that dropping policy. IDs are local to each
process and trace type; they cannot correlate server, proxy, and owner records directly.
The diagnostic lines do not include URLs, paths, keys, queries, hosts, headers,
request bodies, errors, or credentials. Other server output can contain private
data, so inspect and filter before sharing.

For remote development, forward the demo URL's port (4399 by default). The UI,
actions and published document assets all use that browser-facing address, even
if the tunnel assigns a different local port. No callback tunnel is needed.
With [Rex](https://www.superlogical.com/rex/docs/reference/cli#rex-forward-open-flags-url--hostport--block),
open the printed UI URL or explicitly forward port 4399. Terminal-block port
discovery can find both the UI and the owner's private control listener and
refuse to choose between them. The private listener is not for browser access.

## Complete correctness run

Run `just check` (or `node scripts/check.mjs all`) for the entire pipeline.
It can run in the background: `just check > check.log 2>&1 &`. It installs with
`npm ci` once, generates all screenshots first, then overlaps the full test and
real-`hc` e2e suites. Every invocation announces a unique ignored
`.checks/<run>/` directory containing stage logs and atomic `status.json` updates.
After screenshot generation **and cleanup**, `screenshots-ready.json` appears
and the CLI prints `Screenshots ready`. Open that run's `shots/index.html` and
inspect PNGs at original size while the remaining suites run. The marker reports
whether screenshot checks passed; readiness itself is not success. The final
CLI exit status is nonzero for any failed stage, spawn failure, signal, or cleanup
audit. `status.json` records each stage's code and elapsed seconds. Visual review
is mandatory and separately recorded by the reviewer, never automatically
claimed by the command. Runs retain their logs and screenshots on success and
failure; remove old `.checks/<run>/` directories when no longer needed.

Do not overlap independent correctness commands or `npm ci` in one checkout.
The four public commands share `.checks/lock` and reject overlap. A crashed
runner can leave a lock; inspect `owner.json` and confirm its owner has stopped
before removing it. Direct `node --test` and `scripts/test-run.mjs` calls bypass
this guard. The actual unsafe resources are dependency replacement and shared
standalone `shots/` output, not Chromium itself. Bounded concurrency inside the
runner is supported: each test group and e2e run has private Lavish/XDG state,
a distinct port, and its own leak marker; each screenshot uses a separate
browser context and output filename. Screenshot fixture preparation remains serial.
Set
`LAVISH_KIT_TEST_JOBS=1 LAVISH_KIT_SHOT_JOBS=1` for serial diagnosis; each accepts
1–8 (default 3). More workers may hurt latency-sensitive browser tests on busy
machines. No test or screenshot cases are removed by scheduling.

Each full run uses private Lavish and XDG directories and
checks the private Lavish session list and looks for processes inheriting a unique
run marker, including detached children. The final audit allows up to five
seconds for normal detached shutdown before failing, without killing processes.
The screenshot helper checks its own separate private sessions
before removing its state. Processes that discard the marker cannot be identified
by this audit. On failure, the run directory is
retained for inspection.

## `just test`

Runs `npm ci`, then every `*.test.mjs` file in `test/`, balanced across three
isolated groups. Each group runs files sequentially with `node --test
--test-concurrency=1`; tests within a file retain their original order and real
subprocess/browser behavior. Each file has a ten-minute deadline. A timeout fails
the file and stops its process group and marked descendants before the group's
usual session and process audits. Cancellation also stops the active file and
marked descendants.

It includes a small real-Lavish self-test of the screenshot checks: they must
catch overflow, clipping, an overlapped button, a zero-size or off-screen
control, a missing label, and a Lavish-detected layout issue, and pass a clean
page.

The runner enumerates `*.test.mjs` files explicitly (passing the `test/`
directory to Node is not portable across supported Node versions). It disables
Lavish telemetry with `LAVISH_AXI_TELEMETRY=0` for tests and screenshots.
`test/lavish-http.test.mjs` also checks the pinned real server without needing
Chromium. `test/preview-browser.test.mjs` exercises diff navigation, worker
fallback, and row virtualization in the hub preview.

To run a single file: `node --test --test-concurrency=1 test/hub-cli-surface.test.mjs`.
`test/hub-foundation.test.mjs` exercises canonical jj workspace identity,
repository replacement detection, state-directory aliases, recorded missing-workspace
lookup, and capability-protected loopback requests. `test/hub-opening.test.mjs`
checks that opening refuses an incompatible server. The other
`test/hub-*.test.mjs` suites cover runtime lifecycle, documents and metadata,
jj snapshots and edits, commands, browser UI, refresh, and feedback.
The screenshot matrix below includes simulated hub states; inspect a live hub
separately when reviewing its behavior. A disposable review-prep check should
publish a synthetic durable document with metadata to the
invocation workspace, remove the reviewed checkout, and verify the published
scope and source remain available. Never use private review material as a fixture.

Temporary tests are useful during implementation. Before pushing, consider
whether the behavior is likely to regress and whether existing checks would catch
that regression. Keep inexpensive, valuable regression coverage; remove redundant
exploration only when required behavioral coverage remains.

## `just test-e2e`

Runs `test/hub-e2e.mjs` through the isolated runner. It requires a working
`hc` installation, but not the herdr desktop app. The runner starts and stops
only its own private `HC_SESSION`, with a short private socket directory under
`/tmp` to fit macOS socket-path limits. It never stops the user's service.
It creates a scratch jj repository and isolated terminals
(`hc run --bg --no-parent --no-notify`) with synthetic space labels, and checks:

- a foreground hub owner in a real hc terminal receives HTML annotation feedback,
- the notification identifies the workspace, page, and published document,
- the printed reply command delivers a response visible in the browser,
- editing and saving a published Markdown document writes the expected bytes,
- the owner stops and removes its runtime record.

Hub integration tests separately cover stale saves. They do not exercise the
removed relay or retarget workflow.

It ends its pages and removes only its own workers, logs, terminals, and temporary
files. It never sends to the terminal you run it from. Don't point tests at
terminals they didn't create. Automated tests mock the desktop app; actual GUI
integration and phone artifact behavior require manual desktop testing.

## `just shots`

```sh
npm ci            # development dependencies, once
just shots
# Open shots/index.html in a browser
```

Runs `scripts/shots.mjs` with `HC_TERMINAL_ID` unset, headless Chromium, and
real Lavish sessions on a private Lavish server (temporary state, config, and
data directories, its own port, no workers). It replaces the gitignored
`shots/` directory with:

- wide (1440×900), dark primary viewport PNGs covering selected static and real-Lavish hub views,
- full-page and scrolled-pane captures for selected pages that scroll,
- `preview/`, the generated interactive static artifact used for static checks,
- `report.json` (schema version 2) with static and integration check records, timings, and cleanup result; unlike version 1, records distinguish their source and diagnostic-only cases need not have a PNG,
- `index.html`, a gallery linking the preview and distinguishing check-only records from captures.

Fixtures use a scratch jj diff with additions, deletions, renames and long lines.
The simulated hub fixtures are
`hub-empty`, `hub-stack`, `hub-dirty`, `hub-conflict`, `hub-disconnected`,
`hub-changes`, `hub-tasks`, `hub-markdown`, and `hub-html`. They use
the hub UI and deterministic action responses, not a live workspace owner.

Every fixture is checked at both viewport sizes and themes, separately for the
static artifact and real Lavish. Only selected cases produce primary PNGs.
Real-Lavish cases also check Lavish's own layout issues using a fresh complete
audit (the packaged Lavish layout-diagnostics and layout-warnings endpoints). An
incomplete audit fails the case. Both static and real-Lavish cases check:

- Page and console errors.
- Horizontal overflow, text clipped without an ellipsis, and zero-size,
  clipped, off-screen, or covered controls (including in open shadow roots).
- Serious and critical axe-core accessibility violations in the page and, for
  real-Lavish cases, in Lavish's chrome. Two known chrome-only findings (the
  artifact iframe's missing title and the outer document's missing language) are recorded in
  `ignoredAccessibility` but do not fail the run. The same findings in the page,
  other affected elements, and new chrome findings still fail.
- Long wrapped text forced into an extremely narrow column (a heuristic based on
  rendered line widths; it does not replace visual inspection).

It prints `PASS` or `FAIL <checks>` per shot and exits nonzero if any check or
cleanup fails. It doesn't compare pixels. Geometry checks allow one pixel of
rounding, and content below the fold or in scrollable panes isn't a failure.
External browser requests are blocked, except the Markdown CDN styles, which it
serves from local development dependencies. A full run takes a few minutes.

After UI work, open the changed PNGs at their original size.

## Historical timing comparison

The measurements below describe an earlier standalone test matrix and are not
representative of the current hub-only suite.

## Earlier measurements

Measured on the same macOS checkout and installed tools, against base
`ea94b395edd61f7273d0c331292998b8b38a36ee`, using `/usr/bin/time -p` around
each standalone command, one command at a time:

| Command | Base | Bounded concurrency | Change |
| --- | ---: | ---: | ---: |
| `just test` | 277.91 s | 96.51 s | 65% less wall time |
| `just test-e2e` | 39.38 s | 40.71 s | 1.33 s more wall time |
| `just shots` | 340.79 s | 160.84 s | 53% less wall time |

These are single-run comparisons, not thresholds. The base had 162 passing
tests and one opt-in registry skip. All original tests remain, with added
pipeline and process-audit regression tests. The earlier baseline retained all 60 viewport
cases and additional full-page/scroll captures, real Lavish diagnostics, accessibility,
and geometry checks. The e2e suite still exercises real `hc`, browser save/watch,
and moved-session delivery. The main
gains come from overlapping independent real browser/subprocess work and taking
one process snapshot instead of launching `ps` once per host process. Build
and dependency tools are unchanged because their measured cost did not justify
a rewrite. Parallel scheduling uses more peak CPU/memory and can expose timing
flakiness under host load. Linux remains supported but was not benchmarked here.

