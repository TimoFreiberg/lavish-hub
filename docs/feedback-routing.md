# Feedback and actions

The foreground hub owner is the only polling consumer for its review. It prints each feedback batch as a JSON line on stdout, including the workspace, page, prompts, snapshot scope, failures, and a `lavish-hub reply` command. Diagnostics go to stderr. Run the printed reply command with your response; do not poll the same page from another process. See [hub](hub.md) for field and lifecycle details.

## Delivery guarantees

Each save or action keeps the target it arrived with, even if navigation changes while the operation is in progress. Document saves check the version and content they were based on; a conflict keeps the draft for the user to resolve.

Feedback recovery relies on Lavish's native queue and delivery receipts (`Seen`, `Working`, `Done`):

- **Owner offline:** Comments sent while no `lavish-hub listen` owner is running stay queued in Lavish without a `Seen` receipt (`No agent is listening`). Starting `lavish-hub listen` delivers the queued batch as an `agent-notification` and marks the notes `Seen`.
- **Disconnect during poll:** If the owner disconnects while waiting or before Lavish writes a poll response, Lavish releases the listener and restores any in-flight batch to the queue, removing its `Seen` stamp so the next owner receives it cleanly.
- **Ambiguous handoff:** Once Lavish writes a poll response, the batch is removed from the queue and marked `Seen` (without `Done`). A failed consuming poll is not retried: the owner logs an uncertain-delivery warning on stderr and stops rather than risk silently losing or duplicating a batch. The same applies if the owner exits abruptly right after receiving a batch before the agent handles it. Restarting `lavish-hub listen` will not re-deliver an already consumed batch; check the review chat transcript for any `Seen` notes without a reply (or ask the reviewer to resend), then reply and restart `lavish-hub listen`.

The former standalone relay, outbox, and retarget workflows are not available; see [workflow gaps](hub-gaps.md).
