# Feedback and actions

The foreground hub owner is the only polling consumer for its review. It prints each feedback batch as a JSON line on stdout, including the workspace, page, prompts, snapshot scope, failures, and a `lavish-hub reply` command. Diagnostics go to stderr. Run the printed reply command with your response; do not poll the same page from another process. See [hub](hub.md) for field and lifecycle details.

## Delivery guarantees

Each save or action keeps the target it arrived with, even if navigation changes while the operation is in progress. Document saves check the version and content they were based on; a conflict keeps the draft for the user to resolve.

A polling failure is not retried: the server may already have consumed the feedback. The owner stops rather than risk silently losing or duplicating a batch. The former standalone relay, outbox, and retarget workflows are not available; see [workflow gaps](hub-gaps.md).
