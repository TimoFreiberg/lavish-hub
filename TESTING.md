# Testing lavish-kit

This describes the three test commands, what they need, and which failures are
known to be flaky.

Besides the runtime requirements in the [README](README.md), the tests need
`just`, fish, ripgrep, and Playwright's cached Chromium. Set
`LAVISH_KIT_CHROMIUM` to use another Chromium executable.

Never run two of these at once in one checkout. `just test` runs `npm ci`,
which replaces `node_modules` while the other run reads it, and the browser
tests use Chromium. Each full run uses private Lavish and XDG directories and
checks for remaining sessions and processes referring to its temporary directory.
On failure, the directory is retained for inspection.

## `just test`

Runs `npm ci`, then every file in `test/` with `node --test
--test-concurrency=1` (one file at a time). Set `LAVISH_KIT_REAL_NPM=1` to add
a first-run test against the real npm registry.

It includes a small real-Lavish self-test of the screenshot checks: they must
catch overflow, clipping, an overlapped button, a zero-size or off-screen
control, a missing label, and a Lavish-detected layout issue, and pass a clean
page.

To run a single file: `node --test --test-concurrency=1 test/cli.test.mjs`.

## `just test-e2e`

Runs `test/relay-e2e.mjs`. Run it inside herdr, with herdr running. It creates
a scratch jj repository, herdr space, and terminals
(`hc run --bg --no-parent --no-notify`), and checks:

- delivery follows a moved session label,
- the exact saved bytes, page updates, and agent notices,
- Create PR with a stub command from a temporary `XDG_CONFIG_HOME`, through a
  real `tab.new` in the recorded space and repository (no PR command or GitHub
  access),
- that opening commands return before edits,
- that a watch-only Markdown page updates in the browser and its worker stops
  when the session ends.

It ends its pages and removes only its own workers, logs, space, terminals, and
temporary files. It never sends to the terminal you run it from. Don't point
tests at terminals they didn't create.

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

- 60 viewport PNGs: every page kind at 1440×900 and 480×900, light and dark,
- full-page and scrolled-pane captures for pages that scroll,
- `report.json` with each shot's checks and the cleanup result,
- `index.html`, an offline gallery grouped by page kind.

Fixtures cover HTML, Markdown with highlighted code and frontmatter, a jj diff
(additions, deletions, renames, long lines, 180 added lines), an empty diff,
short, long, and empty task files in both views, the unsaved-edit/disk-change
banner, and PR drafts in both views with and without `createPr`. Git diffs use
the same renderer, so there is no git matrix. Diff and PR metadata use fixed
values so temporary paths don't change the layout.

Each shot checks:

- Lavish's own layout issues, from a fresh complete audit (Lavish 0.1.96's
  layout-diagnostics and layout-warnings endpoints). An incomplete audit fails
  the shot.
- Page and console errors.
- Horizontal overflow, text clipped without an ellipsis, and zero-size,
  clipped, off-screen, or covered controls (including in open shadow roots).
- Serious and critical axe-core accessibility violations in the page and in
  Lavish's chrome.

It prints `PASS` or `FAIL <checks>` per shot and exits nonzero if any check or
cleanup fails. It doesn't compare pixels. Geometry checks allow one pixel of
rounding, and content below the fold or in scrollable panes isn't a failure.
External browser requests are blocked, except the Markdown CDN styles, which it
serves from local development dependencies. A full run takes a few minutes.

After UI work, open the changed PNGs at their original size.

## Known flaky tests

- The large-diff timing test in `test/browser.test.mjs` (first row within
  5 seconds) fails under load and passes on rerun.
- The offline browser smoke test in `test/browser.test.mjs` times out
  occasionally. Cause unknown.
