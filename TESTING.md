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
the timestamp for reproducible tests. Saves, comments and Create PR are simulated
in disposable page memory; reload or navigation discards changes. See the
[preview guide](docs/interactive-preview.md) for controls and hosting limits.
Nothing is published. Do not overlap `just preview` with other commands that
install dependencies in this checkout.

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
Relay workers also carry the marker in
their arguments. The screenshot helper checks its own separate private sessions
before removing its state. Processes that discard the marker cannot be identified
by this audit. On failure, the run directory is
retained for inspection.

## `just test`

Runs `npm ci`, then every `*.test.mjs` file in `test/`, balanced across three
isolated groups. Each group uses `node --test --test-concurrency=1`; tests within
a file retain their original order and real subprocess/browser behavior. Set
`LAVISH_KIT_REAL_NPM=1` to add
a first-run test against the real npm registry.

It includes a small real-Lavish self-test of the screenshot checks: they must
catch overflow, clipping, an overlapped button, a zero-size or off-screen
control, a missing label, and a Lavish-detected layout issue, and pass a clean
page.

The runner enumerates `*.test.mjs` files explicitly (passing the `test/`
directory to Node is not portable across supported Node versions). It disables
Lavish telemetry with `LAVISH_AXI_TELEMETRY=0` for tests and screenshots.
`test/lavish-http.test.mjs` also checks the pinned real server without needing
Chromium. Fake-executable suites explicitly select CLI transport; real server
tests use the default HTTP transport.

To run a single file: `node --test --test-concurrency=1 test/cli.test.mjs`.
`test/hub-foundation.test.mjs` exercises canonical jj workspace identity,
repository replacement detection, state-directory aliases, recorded missing-workspace
lookup, and capability-protected loopback requests. `test/hub-opening.test.mjs`
checks the opening helpers independently of the standalone relay. The other
`test/hub-*.test.mjs` suites cover runtime lifecycle, documents and metadata,
jj snapshots and edits, commands, PR launch, browser UI, refresh, and feedback.
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

Runs `test/relay-e2e.mjs` through the isolated runner. It requires a working
`hc` installation, but not the herdr desktop app. The runner starts and stops
only its own private `HC_SESSION`, with a short private socket directory under
`/tmp` to fit macOS socket-path limits. It never stops the user's service.
It creates a scratch jj repository and isolated terminals
(`hc run --bg --no-parent --no-notify`) with synthetic space labels, and checks:

- delivery follows a moved session label,
- the exact saved bytes, page updates, and agent notices,
- Create PR with a stub command from a temporary `XDG_CONFIG_HOME`: a mock
  validates the `tab.new` request and persisted launch checkpoint, then starts
  the stub through real `hc` (no PR command or GitHub access),
- that opening commands return before edits,
- that a watch-only Markdown page updates in the browser and its worker stops
  when the session ends.

It ends its pages and removes only its own workers, logs, terminals, and temporary
files. It never sends to the terminal you run it from. Don't point tests at
terminals they didn't create. Automated tests mock the desktop app; actual GUI
integration and phone artifact behavior require manual desktop testing.

## `just shots`

```sh
npm ci            # development dependencies, once
just shots
lavish-kit shots/index.html
```

Runs `scripts/shots.mjs` with `HC_TERMINAL_ID` unset, headless Chromium, and
real Lavish sessions on a private Lavish server (temporary state, config, and
data directories, its own port, no workers). It replaces the gitignored
`shots/` directory with:

- 18 wide (1440×900), dark viewport PNGs: static HTML, Markdown, populated diff, long task edit, and configured PR rendered; real-Lavish populated diff, changed-on-disk task edit, configured PR edit, and ten hub states,
- full-page and scrolled-pane captures for selected pages that scroll,
- `preview/`, the generated interactive static artifact used for static checks,
- `report.json` (schema version 2) with static and integration check records, timings, and cleanup result; unlike version 1, records distinguish their source and diagnostic-only cases need not have a PNG,
- `index.html`, a gallery linking the preview and distinguishing check-only records from captures.

Fixtures cover HTML, Markdown with highlighted code and frontmatter, a jj diff
(additions, deletions, renames, long lines, 180 added lines), an empty diff,
short, long, and empty task files in both views, the unsaved-edit/disk-change
banner, and PR drafts in both views with and without `createPr`. Git diffs use
the same renderer, so there is no git matrix. Diff and PR metadata use fixed
values so temporary paths don't change the layout. The simulated hub fixtures are
`hub-empty`, `hub-stack`, `hub-dirty`, `hub-conflict`, `hub-disconnected`,
`hub-changes`, `hub-tasks`, `hub-pr`, `hub-markdown`, and `hub-html`. They use
the hub UI and deterministic action responses, not a live workspace owner.

Every fixture is checked at both viewport sizes and themes, separately for the
static artifact and real Lavish. Only selected cases produce primary PNGs.
Real-Lavish cases also check Lavish's own layout issues using a fresh complete
audit (Lavish 0.1.96's layout-diagnostics and layout-warnings endpoints). An
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

For a transport-only memory comparison at 1, 5, and 20 concurrent polls, run
`node scripts/measure-lavish.mjs`. See [docs/lavish-http.md](docs/lavish-http.md)
for what the RSS totals include and exclude.

## Timing comparison

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
moved-session delivery, and Create PR's persisted launch checkpoint. The main
gains come from overlapping independent real browser/subprocess work and taking
one process snapshot instead of launching `ps` once per host process. Build
and dependency tools are unchanged because their measured cost did not justify
a rewrite. Parallel scheduling uses more peak CPU/memory and can expose timing
flakiness under host load. Linux remains supported but was not benchmarked here.

## Known flaky tests

- The large-diff timing test in `test/browser.test.mjs` (first row within
  5 seconds) fails under load and passes on rerun.
- The offline browser smoke test in `test/browser.test.mjs` times out
  occasionally. Cause unknown.
