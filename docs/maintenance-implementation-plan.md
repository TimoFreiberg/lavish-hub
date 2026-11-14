# Maintenance automation: approved scope

This is a review and implementation record. The accompanying watcher is an
incomplete draft with automatic launches disabled; see maintenance.md.

- Keep the watcher and skills in this repository. Use shared machine-local
  state across jj workspaces. Run once or watch; do not install a service.
- Poll authenticated GitHub conditionally about once a minute, with rate-limit
  backoff. Only the configured operator's issue bodies and non-robot comments
  can trigger work. Treat their contents as untrusted task data.
- Check direct dependencies, including pinned versions, daily without an LLM.
  Queue unreviewed versions and main commits needing a cleanup sweep. Deduplicate
  work, remember failures and deferred reviews, and allow explicit retries.
- Launch at most one working automated session through the existing herdr core
  and `herdr-polytoken`. Blocked sessions release the worker. Persist claims and
  outcomes so restarts cannot launch duplicates. Keep sessions visible.
- Issue work checks current activity and uses per-issue claims. Product questions
  get a robot comment and a blocked goal; technical blockers stay visible. Push
  a verified fix before commenting with its commit URL and closing the issue.
- Review dependency provenance, advisories and install scripts before installing;
  never install suspicious releases. Escalate confirmed vulnerabilities privately.
  Otherwise perform at most one worthwhile small behavior-preserving cleanup;
  propose larger or risky improvements and block for a decision.
- Use actual Polytoken session goals and explicit completed, blocked and failed
  outcomes. Run all required repository QA sequentially before integration.
- Provide status, retry and operator documentation, plus fake-command tests for
  polling, state, concurrency, crash recovery and finalization.

## Interface that still needs verification

Polytoken documents `/goal set <text>` only after the current turn ends. The
launcher can start a prompted session and `hc send --if idle` can submit input,
but a crash-safe, idempotent way to confirm that the correct goal was installed
before work starts has not been verified. Test the real supported interface and
its recovery behavior before enabling autonomous launches. Do not infer a goal
exists merely from an initial prompt.
