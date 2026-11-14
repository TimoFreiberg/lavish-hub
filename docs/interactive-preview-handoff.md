# Interactive preview handoff

## Goal

Build a linked, navigable live HTML sample of the actual application pages. A person should be able to explore it on a desktop or phone and use the representative controls. The sample is the primary artifact. Headless Chromium must visit that same generated output to produce screenshots and reports; do not maintain a separate screenshot-only fixture or a hand-coded imitation of the UI.

This document is a handoff, not an implementation or a deployment authorization. Start a fresh session by inspecting the current tree and history, then implement and review the work below.

## Current state and boundaries

- `scripts/shots.mjs` builds the app, generates page variants with `writeMarkdown`, `writeDiffPage`, `writeTaskPage`, and `writePRPage`, opens them in isolated Lavish sessions, and produces PNGs, `report.json`, and a screenshot gallery. Fixtures are in `test/visual/fixtures/`. `scripts/visual/browser.mjs` manages the isolated server, offline routes, and Lavish diagnostics; `scripts/visual/checks.mjs` runs layout and accessibility checks. See `TESTING.md` for the current matrix and check contract.
- Page generation lives in `src/markdown.mjs`, `src/diff/page.mjs`, `src/document-page.mjs`, and `src/pr-page.mjs`; inspect their browser bundles and service boundaries before choosing the adapter. `HANDOFF.md` and `docs/feedback-routing.md` describe existing delivery and recovery constraints.
- The local maintenance stack is linearized above `main` `afc574c0`. It includes the visual changes `e8df54f5` and `33bb7f6c`, and ends at `ff544197` (change `mqruonwn`, mock desktop integration in automated tests). The reported full QA on that earlier tree was 162 passed, one skipped, e2e passed, and 60 shots passed. This handoff has not received that full QA. Recheck history and workspace state before acting; do not treat those results as verification of a later tree.
- A medium-severity cleanup review finding remains: a journal can leak after `hc` startup. Inspect and resolve it separately before integrating the maintenance work. No merge or push is authorized by this handoff.

## Intended behavior

1. Generate a browsable index linking representative HTML, Markdown, diff, task, and PR pages, including the current empty, long, edit/rendered, configured/unconfigured, and changed-on-disk states. Inspect the current variant list and add any modes or states introduced since this handoff. Links and navigation must work on a phone as well as a desktop.
2. Use the real production renderers and browser UI, with an in-browser demo adapter at existing service boundaries where possible. Make edits, view changes, conflict choices, navigation, and actions usable, with clear feedback that saves and actions are simulated. The preview must not contact GitHub or herdr, run real actions, or write user files. Keep sample state local and disposable. Do not fork the production UI to achieve this.
3. Make responsive layout genuinely adapt at phone widths, rather than scaling a desktop screenshot. Provide working light and dark theme selection and verify the rendered colors actually differ where expected: earlier light/dark captures may have been identical because generated pages default to dark. Test interactions at both sizes, not just screenshots.
4. Produce reusable static-hosting output with relative, subpath-safe URLs and locally bundled assets. It must work without a localhost service or CDN at the visitor's device. Serve the exact generated output locally to headless Chromium for screenshots and checks. If a required interaction cannot work in a truly static build, identify the minimal server contract and its tradeoffs explicitly before adding a tiny server; do not quietly claim static hosting works.
5. Keep fixtures and build code in version control. Keep generated preview output and screenshots ignored unless the operator chooses otherwise. Preserve the existing screenshot report, scroll captures, accessibility and layout coverage, page/console error checks, cleanup auditing, and original-size visual review. Lavish-specific chrome and layout diagnostics currently require a real Lavish session: retain equivalent coverage with an explicit separate integration check if the static output cannot supply those diagnostics, and document any unavoidable difference rather than silently removing checks. Screenshots remain an agent review tool, not the primary user interface.

## Delivery and hosting

Build published output from a specific `main` commit. The eventual hosting scheme should expose a stable, shareable URL that identifies that commit and build timestamp. Choose the precise URL and retention policy with the hosting destination; no provider, deployment credentials, or automatic publishing has been selected. During development a branch preview is useful, but do not move bookmarks merely to create one. Do not publish automatically until a destination and authorization are established.

## Implementation sequence

1. Inventory the renderer inputs, browser-side service calls, current screenshot variants, and Lavish chrome dependencies. Map each interactive operation to a safe demo response and record any behavior that cannot be represented statically.
2. Build the linked output using the production renderers and shared fixture data. Add a narrowly scoped demo adapter and portable local assets. Keep production relay paths and semantics unchanged.
3. Change the screenshot runner to serve and visit this output, selecting states through the same links and controls or documented deterministic URLs. Retain the existing checks and add the separate Lavish integration coverage where necessary.
4. Test navigation, keyboard and touch-sized interaction, simulated action feedback, absence of external requests and real writes, theme differences, narrow and wide layouts, and hosting under a non-root URL prefix. Verify the screenshot runner visits the generated sample, not a second generation path. Inspect representative PNGs at original size and review both the implementation and any coverage differences.
5. Run `just test`, `just test-e2e`, and `just shots` sequentially under the repository's integration procedure, with full QA on the exact integration tip. The e2e suite needs a working `hc` service and mocks `herdr-app`; do not require the desktop app for automated tests or replace the `hc` coverage with a blanket mock. Keep manual phone artifact and desktop integration checks separate: a successful terminal test or desktop artifact does not prove phone behavior.

Preserve the relay guarantees in `docs/feedback-routing.md`: each save or action retains its receipt target, and Create PR records the launch attempt before calling herdr. The demo must not weaken or exercise those real side effects.

## Acceptance

A reviewer can open one generated, linked sample under a static host subpath, navigate and interact safely on desktop and phone, switch visibly distinct themes, and see clear simulated outcomes. The screenshot job visits that same output and retains the documented checks, with any real-Lavish-only checks accounted for separately. Build and fixture sources are committed, generated output is not accidentally committed, and the exact tested revision and remaining manual checks are reported. Hosting remains an explicit operator decision.
