# Handoff status

Updated 2026-11-13, from latest main `7158a154187477428923bfe6746ede7f5aa11d3b`.
Keep this file until the remaining verification and proposals below are resolved.
The README rewrite remains owned by the user and was not changed.

## Interactive preview follow-up

The interactive fixture preview and representative captures are implemented on
the task branch. See [the preview guide](docs/interactive-preview.md) and
[testing instructions](TESTING.md). Publication is not configured or authorized.
The earlier verification below describes a different revision and environment;
it is not evidence that the preview has passed exact-tip integration checks,
original-size image review, physical-phone testing, or desktop-app testing.

## Completed in this change

- Background Lavish polling and replies now use direct loopback HTTP, with
  explicit support for Lavish 0.1.96, server version/state checks, exclusive
  listener ownership, cancellation, and no ambiguous consuming-poll retry.
  Watch-only session checks read the same non-consuming store as the CLI.
  Opening reviews still uses the CLI. Explicit CLI compatibility remains via
  `LAVISH_KIT_LAVISH_TRANSPORT=cli`. See `docs/lavish-http.md`.
- Real-server transport tests cover feedback, competing listeners, reply, end,
  unsupported versions, wrong state, and truncated responses. Existing outbox,
  handler, receipt-target, and Create PR launch-attempt guarantees are retained.
- A reproducible transport RSS comparison covers 1, 5, and 20 pages. At 20,
  summed RSS dropped from 1343.9 to 123.4 MiB (22 processes to 2). This includes
  Lavish and polling processes, not herdr, a browser, or the full relay.
- A separate 20-to-1-page check found no immediate Lavish RSS reduction
  (64.1 to 66.1 MiB after one second). The final session end stopped the server.
  Neither that fixture nor the transport comparison proves a whole-app memory
  target or a long-lived retention problem.
- Relay default state paths now match the installed Lavish default,
  `$HOME/.lavish-axi`, rather than the previously assumed XDG state directory.
- Generated Markdown, PR and diff pages default to dark mode, including syntax
  highlighting and native controls (issue #1's generated-page portion).
  Existing user-authored HTML preserves its appearance.
- Task-list checkboxes have text labels. Code blocks are keyboard-focusable
  scroll regions. Generated diff pages declare their language.
- The test runner enumerates test files explicitly instead of passing a
  directory to Node. Tests, screenshots and memory probes disable Lavish
  telemetry with its supported `LAVISH_AXI_TELEMETRY=0` option.
- The new shared renderer helper is included in bundle cache invalidation;
  dependency fixtures copy the complete source tree.

## Verification

Linux, Node 24.22.1, jj 0.47.1, fish 4.0.2, Lavish 0.1.96:

- Final `just test`: 148 tests, 102 passed, 45 failed, 1 optional real-npm test
  skipped. The 45 failing test names are identical to the unchanged-main
  baseline (99 passed, 45 failed, 1 skipped). The three new HTTP tests pass.
- The remaining failures include blocked Chromium startup and Unix socket
  `EPERM` in relay registration. They are not a clean Linux support verdict.
- The corrected dependency, diff-shell and HTTP targeted run: 8 passed,
  1 optional test skipped, no failures. Browser bundles build successfully.
- Final `just shots` failed before taking any screenshots: Chromium cannot
  create its process-singleton Unix socket in this command environment.
  No screenshot or visual inspection of the changed UI was possible.
- Full-suite cleanup audits reported no private Lavish sessions and no
  processes carrying the run marker. Screenshot cleanup also passed.
- `just test-e2e` remains unavailable: no running herdr, `hc`, or `herdr-app`.
- A cloud-browser attempt could not reach the command runtime's localhost.
  Official Work docs describe connected desktop and browser-enabled cloud
  routes, but no supported mobile switch that fixes this socket restriction.
  See https://learn.chatgpt.com/docs/browser and
  https://learn.chatgpt.com/docs/get-started-with-work.

## Remaining work for review

See `docs/review-proposals.md` for concrete options and tradeoffs:

1. Issue #2: unchanged-line expansion. The diff library supports lazy hydration,
   but we must supply the exact old/new revision contents and verify line
   coordinates, virtualized layout, split/unified rendering and stdin behavior.
2. Unify page Send and sidebar Send, then decide Cmd/Ctrl+S semantics.
3. Inspect narrow diff headers/sidebar in a working browser before redesigning.
4. Implement lifetime/Not live/resume only with non-consuming browser presence.
   Lavish 0.1.96 keeps browser counts internally; `/health` exposes listeners,
   not browser counts. A consuming poll is not an adequate watch-only probe,
   and observing through an event connection would count as a browser.
5. Update the external herdr Artifacts/background opener to resume pages once
   that contract exists. Those dotfiles and their tests are not in this repo.
6. Run `just shots`, inspect the PNGs, and run `just test-e2e` inside herdr on
   a machine with working Chromium and Unix sockets. Audit Lavish shell issues
   separately from generated-page issues; do not claim visual fixes verified.
7. Measure a complete realistic 1/5/20-page workflow, including renderers,
   herdr, browser and aged sessions, on macOS and unrestricted Linux.

## Recovery constraints retained

No recovery migration or deletion was performed. A consumed batch is written to
its outbox before saves, actions or terminal delivery. If that persistently
fails, try XDG emergency recovery; warn loudly and stop if both fail. A failed
poll may have consumed feedback without returning a complete response, so stop
and ask for inspection/resend instead of silently retrying it.

Each save/action keeps its receipt source and reviewed PR repository/revision.
Create PR records its launch attempt before calling herdr. Pending recovery
records without receipt targets may acquire only matching-generation targets;
mismatches stop processing. Records without enough identifying information
require manual inspection. Never replay a Create PR action manually as well.
See `docs/feedback-routing.md` for the full procedure.

`src/markdown.mjs` remains used by the watch renderer, legacy Markdown fixtures,
and tests. It was not removed. Recheck callers before attempting removal.

## Repository state

Changes are committed locally with jj. No remote push, bookmark movement,
issue closure or PR publication was performed. The repository requires the
operator's approval before pushing or moving bookmarks.
