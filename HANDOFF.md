# Handoff: fixes, memory work, Markdown editing, docs

Temporary file. Delete it once everything below is done.

Written at commit `c35ec9d9921e` (lavish-kit `main`). Everything listed as
"done" is committed there. Nothing below "To do" has been started.

## Where things stand

- lavish-kit is a fresh public repo at
  <https://github.com/TimoFreiberg/lavish-kit>. Commits must be authored as
  `Timo Freiberg <5281645+TimoFreiberg@users.noreply.github.com>`. Set it
  per repo after cloning:
  `jj config set --repo user.name "Timo Freiberg"` and
  `jj config set --repo user.email "5281645+TimoFreiberg@users.noreply.github.com"`.
- Pushing: on the old machine the SSH key authenticated as a different
  GitHub account, so `origin` uses HTTPS and the push used
  `GH_TOKEN=$(gh auth token --user TimoFreiberg)` with
  `gh auth git-credential` as the credential helper for that one command.
  Check which account SSH uses on the new machine (`ssh -T git@github.com`).
- The dotfiles repo (`~/dotfiles`) installs lavish-kit by symlinking
  `~/.local/bin/lavish-kit` to `~/src/lavish-kit/bin/lavish-kit` and deploys
  `~/.config/lavish-kit/config.json` with
  `{"createPr": ["fish", "-c", "jprc $argv", "--"]}` (chezmoi templates
  `home/dot_local/bin/symlink_lavish-kit.tmpl`,
  `home/dot_config/lavish-kit/config.json.tmpl`). The Lavish skills
  (`agents/skills/lavish`, `agents/skills/diff-review`), the plan-view hook
  (`agents/hooks/lavish-plan-view`, tested by `just test-lavish-plan-view`)
  and `config/herdr-app/README.md` refer to lavish-kit.
- The herdr Artifacts UI lives in dotfiles: `config/herdr-app/mods/task-artifacts/`
  and `config/herdr-app/mods/task-tree/artifact-logic.js` (tests:
  `config/herdr-app/tests/*.cjs`, run each file separately).
- Lavish is `lavish-axi` 0.1.96 (installed via mise). Its README and `dist/`
  are the reference for anything Lavish does; several features below depend
  on its internal HTTP API, which is version-specific.

### Done

- Relay: inside herdr, a per-page background worker polls Lavish and delivers
  feedback to the agent's terminal with `hc send`, resolving the target by
  the terminal's `polytoken.session` label. Outbox, `lavish-kit retarget`,
  crash recovery, conditional saves, Create PR via configured command.
- Watching moved into the worker; every command returns immediately; the
  worker exits when the Lavish session ends. Outside herdr the worker only
  watches and the agent polls (same as plain Lavish).
- `just shots` (`scripts/shots.mjs`, `scripts/visual/`): 60 shots of every
  page kind at 1440 and 480 px, light and dark, through a private Lavish
  server; `report.json` and a gallery at `shots/index.html`; checks for
  Lavish's own layout issues (read from its `/api/<key>/layout-diagnostics`
  and `/api/<key>/layout-warnings` endpoints), page/console errors,
  overflow, clipped text, unreachable controls, and axe-core accessibility.

## To do, in this order

### 1. Open review findings (small)

From the screenshot work:

- **R1a (high).** `scripts/visual/browser.mjs:65–69, 96–97`: the cleanup
  fallback verifies the private Lavish server with separate `ps` calls, then
  signals a bare PID (`process.kill(serverProcess.pid, signal)`). If the
  process exits and its PID is reused in between, an unrelated process of
  the same user is killed. Fix: start the private server as a child process
  and only signal through that handle, or drop the forced kill and report
  "cleanup incomplete". Never signal a PID found via `ps`.
- **R4a (medium).** `scripts/visual/checks.mjs:40, 45–48`: for text inside a
  scrolling pane, the text rectangle is replaced by the whole pane before
  outer clipping is checked, so fully visible text in a partly clipped pane
  is reported as clipped. Intersect the text's visible region with the pane
  instead. Add a clean one-line fixture next to the clipped one in
  `test/visual/fixtures/clipping.html`.

From the relay work:

- **COR-06 (medium).** `src/relay.mjs` (around the `stop`/`undurableBatch`
  logic and the first outbox write in `deliverFeedback`): shutdown waits
  until consumed feedback is written to the outbox. If that write can never
  succeed (disk full, unwritable state), the worker never exits, even on
  repeated SIGTERM, and keeps its lock. Bound the wait or let a second TERM
  force the stop, and report the possible loss loudly. Never drop feedback
  silently. Test with a writer that always fails.
- **COR-07 (medium).** `src/cli.mjs` (`recordWatch` before `openReview`),
  `src/lavish.mjs` (`recordTarget`), `src/watch.mjs` (`startDelivery`): when
  a running watch-only worker is promoted to delivery, it can start
  delivering before the new target is recorded. If the page previously
  delivered for a different source at the same `--out` path, the first
  feedback can be handled against the old file or PR. Start delivery only
  after the matching target is written (for example, a shared generation
  number in the watch spec and the target). Test with a delayed target write.

### 2. Process and session leaks (must fix)

Observed on the old machine: about 110 `src/relay-worker.mjs` processes
(around 85 MB each, about 7.7 GB in total), running for hours. Almost all were for
`$TMPDIR/lavish-cli-*/page.html` pages created by the test suite and since
deleted. Also stub `lavish-axi` processes under `$TMPDIR/lavish-relay-*`,
and Chrome for Testing processes whose parent had exited. They were killed
by hand.

Separately, the user's real Lavish server (port 4387) held 7 sessions from
lavish-kit tests (`$TMPDIR/lavish-pr-browser-*`, `lavish-task-browser-*`,
`lavish-watch-*`, `lavish-scroll-*`), which means some tests use the real
server instead of a private one and never end their sessions.

Likely causes, to confirm:

- A watch-only worker treats a failing Lavish session listing as "retry",
  so a worker whose page or Lavish state disappeared never exits.
- Tests don't stop the workers and browsers they start, especially on
  failure.
- Some browser tests don't isolate Lavish state (`LAVISH_AXI_STATE_DIR` or
  equivalent) and don't end their sessions.

Fix:

- A worker exits when its page file and sidecars are gone, or its Lavish
  state disappears.
- Every test that starts a worker, a Lavish session, or a browser stops it
  in teardown, including on failure, and uses private Lavish state.
- `just test` and `just shots` fail at the end if any process they started
  is still alive or any session they opened is still listed. Check with
  `ps` and `lavish-axi` (no arguments lists open sessions without consuming
  feedback) after full runs.

### 3. Memory

Measured per open lavish-kit page: the worker (24–71 MB) plus a
`lavish-axi poll` child process (20–93 MB) that is restarted every few
minutes. About 50–160 MB per page. Lavish's own server is separate and was
at 866 MB with 26 open sessions; that is upstream (see below).

Planned changes, largest saving first:

1. One lavish-kit daemon for all pages instead of one worker per page. It
   owns the per-page state, locks, outbox and watchers. Keep the existing
   on-disk formats where possible so `retarget` and recovery keep working.
   Starting and finding the daemon must be race-free (one daemon per user
   and Lavish state dir), and it must exit when no pages are left.
2. Talk to the Lavish server over HTTP instead of spawning `lavish-axi poll`
   per page. Find the endpoints the CLI uses for poll, reply, end and
   session listing in Lavish's `dist/cli.mjs` and `dist/server.mjs`. Keep
   the exclusive-listener behavior (`--owner`, `LISTENER_ACTIVE`). Pin the
   supported Lavish version and fail loudly on an unknown one.
3. Render in a short-lived child process. Shiki, markdown-it and the diff
   renderer run only when a page changes; the daemon spawns a renderer and
   lets it exit, so the long-running process stays small.

Target: lavish-kit uses about 50–70 MB in total regardless of how many pages
are open. Measure before and after (`ps -o rss`) with 1, 5 and 20 open
pages and write the numbers in the commit message.

A Rust daemon was considered and rejected for now: it would save about
another 50 MB, but rendering is JavaScript anyway, and it would mean
rewriting the delivery and recovery logic. Revisit only if Lavish's own
server turns out to be the real memory problem.

Upstream: check whether Lavish's server memory drops after ending stale
sessions. If it stays high, report it at
<https://github.com/kunchenguid/lavish-axi/issues>.

### 4. Markdown editing, save on Send, self-cleaning workers

Approved decisions:

1. **One Markdown mode.** `lavish-kit file.md` (and `.markdown`) always
   opens the editable page, starting in the Rendered view, with an easy way
   to switch to editing. The rendered view keeps the read-only page's
   quality: Shiki highlighting, the same markdown-it plugins, frontmatter
   handling. Remove the `task` subcommand and the separate read-only
   renderer once nothing uses them. Nothing in naming, UI or docs is
   task-specific.
2. **Edits are saved on Send.** No Save button. An edit is written to disk
   when the user presses Lavish's Send, which also sends queued comments.
   A clear, always-visible note in the editor says so; the page may show
   its own Send button that is visibly the same action. Show states such as
   "unsent edits" and "saved" so the user never wonders whether the file is
   on disk. On Send, keep the conflict rule (refuse if the file changed
   since the edit started), and deliver the comments plus one short "user
   edited FILE" note together. Today Save calls Lavish's
   `sendQueuedPrompts()`, which also sends every queued comment; that is
   what this replaces. Find out from Lavish's source how a page can keep
   exactly one up-to-date queued edit (replace or remove a queued prompt,
   or a hook before send). If there's no clean way, stop and decide with
   the user. Apply the same model to PR drafts; Create PR stays an
   explicit action and must say that it also sends queued items.
3. **Self-cleaning workers** (with the daemon from step 3, these become
   per-page lifetimes inside it):
   - Inside herdr: a page is dropped when its Lavish session ends, or when
     no review tab is connected (Lavish poll's `browser_disconnected`) and
     the agent session that opened it is gone (no live terminal with its
     `polytoken.session` label, or the recorded terminal is gone for pages
     without a session). While the agent lives, keep it. Undelivered
     feedback stays in the outbox.
   - Outside herdr: dropped when the session ends or after no review tab
     has been connected for 10 minutes. Needs a way to know whether a tab
     is connected without consuming feedback.
   - A page whose worker is gone shows a "Not live" banner with the command
     to resume, detected from a heartbeat the page already polls.
     `lavish-kit resume <page>` (or reopening by page path) restarts it from
     the sidecars.
   - In dotfiles, the Artifacts modal and automatic background opening
     resume lavish-kit pages through lavish-kit (bare `lavish-axi` stays for
     other registered HTML). Update the herdr-app tests.
   - Keep: consumed feedback is never dropped.

UI issues seen in the screenshots that this step should fix: every heading
shows a large blue underlined `#` permalink; the editor preview uses a
different code font with no highlighting.

Other findings from `just shots` (not yet scheduled): task-list checkboxes
without labels, low-contrast light-mode syntax colors in Markdown code and
diffs, no `lang` on the diff page, keyboard-unreachable scrolling code
blocks, the diff page ignores dark mode, and at 480 px Lavish flags clipped
diff file headers. Lavish's own page shell fails two accessibility checks
in every shot (upstream).

### 5. Docs rewrite (last)

The operator wants it written by a docs-focused writer, for the operator and
agents, not as a product. No marketing, no filler.

- `README.md`, short:
  - Opening line in substance: "lavish-kit contains features I want around
    [Lavish](https://github.com/kunchenguid/lavish-axi), plus herdr
    integration."
  - Install: the mise config line that installs it (check that mise can
    actually install it from GitHub; don't invent one; fall back to the
    checkout install if not), plus runtime dependencies (Node version, npm,
    `lavish-axi`, optionally herdr's `hc` and `herdr-app`).
  - One short paragraph per feature (fewer than five sentences): HTML pages,
    Markdown (editable, saved on Send), diffs, PR drafts, and herdr feedback
    routing ("inside herdr, a background listener routes Lavish feedback
    back to the agent's pane; outside herdr it works like plain Lavish").
  - At most one link, to a features index; other docs are reached from
    there. No tests, file formats, logs, edge cases, recovery details,
    Create PR config or retarget in the README.
- `docs/`, one file per topic, each opening with what it's for: features
  index; Markdown, diffs, PR drafts (Create PR config lives here);
  feedback routing (how the listener remembers who opened the page and
  checks it's still the right session, the outbox, a short "Retarget"
  section, worker lifetime and resume, delivery guarantees in a few
  sentences); files and logs (all files, sidecars, logs, message formats);
  every command and option (one `cli.md` or per feature doc).
- Testing doc (`TESTING.md` or `docs/testing.md`): `just test`,
  `just test-e2e`, `just shots` and its checks, and that `just test` runs
  must not overlap. `AGENTS.md` stays short and points to it.
- Drop edge cases that don't help anyone act; keep failure modes that need
  an action (save conflicts, retarget).
- Check every claim against the code.

## Testing notes

- `just test` must not run twice at once: `npm ci` replaces `node_modules`
  while the other run reads it. It runs test files one at a time.
- The large-diff timing test in `test/browser.test.mjs` (first row under
  5 s) fails under load and passes on rerun. The offline browser smoke test
  times out occasionally. Cause unknown.
- `just test-e2e` creates its own scratch herdr space and terminals and
  removes them; it needs herdr running. Never point tests at terminals you
  didn't create.
- Agents in the old setup couldn't view PNGs; if yours can, look at the
  changed shots after UI work.
