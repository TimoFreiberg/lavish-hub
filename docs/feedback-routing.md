# Feedback and actions

The foreground hub owner is the only polling consumer for its review. It prints each feedback batch as a JSON line on stdout, including its `batchId`, workspace, page, normalized prompts, and failures. Diagnostics go to stderr. Reply with `lavish-hub reply --batch ID 'response'`. Do not poll the same page from another process. See [hub](hub.md) for field and lifecycle details.

## Delivery guarantees

Each save or action keeps the target it arrived with, even if navigation changes while the operation is in progress. Document saves check the version and content they were based on; a conflict keeps the draft for the user to resolve.

Feedback recovery relies on Lavish's native queue and delivery receipts (`Seen`, `Working`, `Done`):

- **Owner offline:** Comments sent while no `lavish-hub listen` owner is running stay queued in Lavish without a `Seen` receipt (`No agent is listening`). Starting `lavish-hub listen` delivers the queued batch as an `agent-notification` and marks the notes `Seen`.
- **Disconnect during poll:** If the owner disconnects while waiting or before Lavish writes a poll response, Lavish releases the listener and restores any in-flight batch to the queue. It removes the provisional `delivered_batches` record and undoes its `Seen` stamps so the next owner receives it cleanly.
- **Ambiguous handoff:** Once Lavish writes a poll response, the batch is removed from the queue and marked `Seen` (without `Done`). A failed consuming poll is not retried: the owner logs an uncertain-delivery warning on stderr and stops rather than risk silently losing or duplicating a batch. The same applies if the owner exits abruptly right after receiving a batch before the agent handles it. Restarting `lavish-hub listen` will not re-deliver an already consumed batch; check the review chat transcript for any `Seen` notes without a reply (or ask the reviewer to resend), then reply and restart `lavish-hub listen`.

A batch-bound reply stamps `Done` only on the open delivered prompts with that
batch's `delivery_seq`, leaving other delivered batches `Seen`. A batch containing
only artifact failures has no prompt delivery sequence and does not stamp other
prompts. Lavish records the batch ID and, when available, page on the reply. It
retains at most 50 delivered batch records per session across reopen and owner
restarts. An unknown or evicted batch returns `404 BATCH_NOT_FOUND`, and an already
replied batch returns `409 BATCH_ALREADY_REPLIED` with `replied_at`. A legacy unbound
reply (omitting `batch_id`) stamps `Done` on all open delivered prompts and marks
those open delivered batches as replied, so a later `reply --batch` for any of them
returns `409 BATCH_ALREADY_REPLIED`.

Delivery errors use the structured stderr format in the
[command reference](cli.md). `action=check_delivery` on `AMBIGUOUS_DELIVERY`,
`REPLY_DELIVERY_UNCERTAIN`, or `BATCH_ALREADY_REPLIED` means inspect the review
chat before retrying. `BATCH_NOT_FOUND` uses `action=fix_args` (verify the ID and
session, and account for eviction). Missing-session (`NOT_FOUND`), connection, and
ended-session errors use `action=reconnect`, and missing cached context uses
`action=refresh`.

The former standalone relay, outbox, and retarget workflows are not available; see [workflow gaps](hub-gaps.md).
