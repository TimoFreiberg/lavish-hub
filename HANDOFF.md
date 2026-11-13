# Temporary handoff

Delete this file when the remaining work is finished. The work started from
`570c06bce61f`; the latest commit at handoff is `b05f2358`.

## Current state

- The screenshot cleanup and clipping review fixes and the relay promotion and
  shutdown fixes are in. Test runs use private Lavish and XDG state and audit
  sessions and processes started by the run. Recovery and concurrent daemon
  registration have tests.
- One shared relay daemon handles pages for a user and Lavish state directory.
  Watched pages render in short-lived child processes. The daemon still invokes
  the Lavish CLI for polling and other operations. It exits when its last page
  stops; rerunning the opening command starts a stopped worker.
- Markdown and PR drafts start in Rendered view and use the page's Send button,
  labelled `(use this instead of sidebar send)`. Sidebar Send does not reliably
  save edits. Page Send sends the edit and queued comments; Create PR is a
  separate action that also sends queued comments. See `docs/markdown.md` and
  `docs/pr-drafts.md` for conflicts and outside-herdr handling.
- Consumed feedback goes to the outbox before saves, actions, or delivery. If
  the outbox write fails repeatedly, the worker attempts emergency storage under
  `${XDG_DATA_HOME:-$HOME/.local/share}/lavish-kit/recovery/`. Follow
  `docs/feedback-routing.md` to recover it; don't manually replay an action as
  well. A failed poll can have an unknown outcome before feedback reaches the
  worker, and at-least-once delivery can duplicate a message.
- The user authorizes loss only if both normal outbox storage and XDG emergency
  recovery fail, with a loud warning. Don't silently discard consumed feedback.
  Keep the receipt target for each save and action, and record Create PR's launch
  attempt before calling herdr.

## Remaining work

### Memory and Lavish integration

Replace per-page Lavish CLI polling with direct HTTP only after inspecting the
installed Lavish distribution. Endpoint discovery is private and version-specific;
verify poll, reply, end, session listing, and exclusive listener behavior. Pin the
supported Lavish version and fail loudly on unknown versions. Measure RSS before
and after with 1, 5, and 20 pages, including Lavish and any child processes.
The earlier 50–70 MB total target is not verified. Check separately whether the
Lavish server releases memory after stale sessions end.

### Page lifetime and resume

The current worker exits on ended sessions and certain missing files or state,
but it doesn't implement tab-disconnect cleanup or automatic resume. No
non-consuming tab-connection status has been verified. Don't use a consuming poll
just to decide whether to clean up.

The intended behavior is to retain a page inside herdr while its opening agent
session is live, then remove it when no review tab is connected and the agent is
gone. Outside herdr, remove it after ten minutes without a connected review tab.
Keep undelivered feedback in the outbox. Add a Not live banner and a resume
command or equivalent reopening path once detection and recovery are safe.

External dotfiles integration remains: route lavish-kit pages opened from the
herdr Artifacts modal and automatic background opening through the resume path,
while leaving other HTML with Lavish. Update the corresponding herdr-app tests.
The external integration has not been verified in this checkout.

### Recovery and old rendering paths

Inspect pending outbox and emergency records before changing recovery. A pending
item can have a generation but no receipt target; it can only acquire a matching
target, and a mismatch stops processing rather than safely identifying the old
source. Records without enough information require manual inspection. Preserve
this constraint and test any migration; don't infer that every recovery record is
automatically replayable.

`src/markdown.mjs` still contains the older read-only Markdown renderer. Check
its remaining callers, tests, and generated pages before removing it. The CLI's
Markdown path is already editable; don't describe the legacy renderer as removed.

### Visual and platform verification

`just shots` has reported accessibility and layout failures: unlabeled task-list
checkboxes, light-mode syntax contrast, missing diff page language, keyboard
access to scrolling code blocks, diff dark mode, and clipped narrow diff headers.
Lavish's own shell also fails accessibility checks. Reproduce and distinguish
current failures from fixed ones before changing them. The suite exits nonzero
on failed checks, and its audit cannot see processes that discard the run marker.

The herdr end-to-end run was unavailable in this session because `herdr-app`
was not on PATH. Run `just test-e2e` inside a running herdr with `hc` and
`herdr-app` available; it creates and cleans up its own space and terminals.
Linux remains unverified. Test there before claiming platform support.

## Working notes

- Read `TESTING.md` before testing. Never run two test commands concurrently in
  one checkout. After UI changes, run `just shots` and inspect changed PNGs.
  The large-diff timing and offline browser smoke tests have known intermittent
  failures.
- Read `docs/feedback-routing.md` for delivery, retargeting, recovery and
  worker lifetime. The worker uses the environment of the command that started
  the shared daemon, including PATH and XDG settings.
- The separate README rewrite is owned by the user. Don't request or undertake
  it as part of this handoff. Update other relevant docs when behavior changes.
- Keep generated pages and worker files outside the reviewed repository. Follow
  `AGENTS.md` for the repository's privacy and version-control instructions.
