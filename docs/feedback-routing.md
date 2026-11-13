# Feedback routing

This explains how a page's background worker gets Lavish feedback to the agent
inside herdr, what happens outside herdr, and what to do when delivery fails.

Every opening command starts (or reuses) one background worker per page. The
worker keeps the page up to date. Inside herdr it also listens for feedback and
delivers it.

## Inside herdr

lavish-kit treats a command as inside herdr when `HC_TERMINAL_ID` is set.

1. The command runs `hc get $HC_TERMINAL_ID --json` and records the opening
   terminal in `<page>.relay.json`: its address, its `polytoken.session` label
   (if any), and its `herdr.space` label. If `hc` is missing or the terminal
   isn't live, the command fails (Lavish may already have opened the page).
2. The worker becomes the page's only Lavish listener with
   `lavish-axi poll PAGE --owner lavish-kit:PAGE`. Don't poll these pages
   yourself.
3. For each batch of feedback, the worker writes it to the outbox, handles
   saves and Create PR, then sends one `hc send` message to the target terminal
   with the page title and path, the prompts with their quoted context, and the
   `lavish-axi reply` command to answer with.
4. Once `hc` accepts the message, the worker clears the outbox and replies
   `Delivered to <session or terminal>` on the page.

lavish-kit also lists the page under the herdr task's Artifacts with
`herdr-app do task-tree.artifact:...`, without changing focus. This is
optional. If `herdr-app` or the task-tree mod is missing or doesn't acknowledge
within two seconds, the command prints the URL instead (and `--open` opens
it). Delivery works either way.

## Finding the right terminal

Before every delivery the worker lists live terminals with `hc ls --json`.

- If the opener had a `polytoken.session` label, delivery goes to the one live
  terminal with that label. A resumed session in a different terminal still
  gets the feedback.
- If it had no label, delivery goes to the recorded terminal address.
- If no terminal or more than one matches, the worker doesn't deliver. It never
  falls back to the old terminal, since another session may run there now.

## Outside herdr

A worker started without `HC_TERMINAL_ID` only watches. It never polls, saves,
launches commands, or replies. The agent runs `lavish-axi poll`, `reply`, and
`end` itself, as with plain Lavish, and handles saves and Create PR itself
([task-documents.md](task-documents.md#who-writes-the-file),
[pr-drafts.md](pr-drafts.md#create-pr-failures)).

## Reopening a page

There is one worker per resolved page path. Opening the same page again reuses
it and replaces `<page>.watch.json` with the new source or range. The worker
picks that up within a second.

Reopening a watch-only page inside herdr turns on delivery in the same worker.
Reopening outside herdr doesn't turn delivery off in a worker that is already
delivering. The command's second output line always says which case applies,
so follow it rather than guessing.

## Outbox

`<page>.outbox.json` holds feedback that was consumed from Lavish but not yet
delivered, plus the inputs and progress of saves and Create PR actions that
haven't finished. When delivery fails, the worker keeps the feedback there and
posts on the page:

```text
The recorded session or terminal is gone or ambiguous. Feedback is kept in <outbox>. Retarget with lavish-kit retarget '<page>' [--terminal T].
```

(or `Terminal delivery failed. ...` if `hc send` itself failed). Nothing is
dropped. The next delivery or a retarget sends the retained batches together.

## Retarget

```sh
lavish-kit retarget PAGE
lavish-kit retarget PAGE --terminal T
```

Retarget records a new target and sends the outbox to it, even if the old
target is still alive.

- Without `--terminal`, it picks the newest live terminal with a
  `polytoken.session` label in the recorded herdr space. It fails if there is
  none, the space is unknown, or the newest is ambiguous.
- `--terminal T` takes a live address or unique name, in any space, with or
  without a session label.

If sending fails, the new target stays recorded, the outbox stays, and the
command exits 1. Retarget needs the page's existing `<page>.relay.json`. It
doesn't reopen the page or start a worker. If the outbox has unfinished saves
or actions (after a crash), it refuses: rerun the command that opened the page
from a herdr terminal so a new delivering worker finishes them, then retarget.
Reopening outside herdr starts a watch-only worker, which doesn't process the
outbox.

Retarget waits up to 120 seconds for the delivery lock (`hc send` can block
while the user types in the target terminal), then fails. Retry after delivery
finishes.

## Worker lifetime

The worker exits when:

- the Lavish session ends (`lavish-axi end`, Send & End, or Lavish
  `NOT_FOUND`),
- another listener replaces its poll (`LISTENER_REPLACED`),
- it delivered fatal `artifact_failures`,
- it is watch-only and the no-argument `lavish-axi` session listing succeeds
  without this page.

Failed polls (including `LISTENER_ACTIVE`, when another listener owns the
page) are logged and retried with backoff of up to 30 seconds, so the worker
never takes over another listener. Failed listings are logged and retried every
second.

Nothing restarts a stopped or crashed worker. Rerun the command that opened
the page to start a new one. Inside herdr, the new worker first finishes
pending saves and actions from the outbox; outside herdr it only watches and
leaves the outbox alone. To stop a worker without ending the review, send TERM
to the PID in `<page>.relay.lock/pid`. Locks left by dead processes are reclaimed on the
next open.

## Delivery guarantees

Delivery is at least once. The outbox is written before sending, so a crash
after `hc` accepts a message but before the outbox is cleared sends it again.
Lavish has no acknowledgement, so a crash between receiving a poll result and
writing the outbox can lose that batch. Poll output the worker can't decode is
forwarded raw with a warning. A failed page reply is only logged, which can
leave "Working" showing on the page.

Each save or action keeps the source file and PR repository and revision it
arrived with, so reopening a different document at the same page path can't
redirect it. Delivery and the Create PR tab's space follow the current target.
Create PR records its launch attempt before calling herdr, so a restarted
worker never opens a second tab. Keep both properties when changing delivery
(`src/relay.mjs`, `src/pr-action.mjs`).

Recovery covers process crashes, not filesystem loss or power failure.
