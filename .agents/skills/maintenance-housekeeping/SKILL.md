---
name: maintenance-housekeeping
description: Review assigned dependency updates and perform a small maintenance sweep.
---

Before work, use `propose_goal` and wait for acceptance; if approval is needed,
leave the session blocked. Never assume a goal exists. Read the assignment with
`node scripts/maintenance.mjs job ID`. Review dependencies before cleanup.
Research release provenance, advisories, supply-chain evidence and install scripts
before installing any candidate. No research can guarantee safety; never install a
suspicious release. All version upgrades, including pinned versions, are eligible
if intended behavior is preserved. Record deferred reviews in the outcome.

For a confirmed current vulnerability, do not disclose sensitive details publicly.
If a safe high-confidence patch is possible, perform full QA and push first, then
block and escalate privately with an exposure summary. Otherwise block first.

If no dependencies change, spend roughly 30 minutes excluding QA finding one
worthwhile small behavior-preserving cleanup; avoid cosmetic churn. If the best
improvement is medium, large or risky, propose it in this visible session and
block for the operator. Local questions are appropriate for that decision.
Follow AGENTS.md for all QA and integration. On completion run
`node scripts/maintenance.mjs outcome ID completed`, then `complete_goal`.
On a blocker record `outcome ID blocked 'reason'` and call `block_goal`; on
failure record `outcome ID failed 'reason'` and block the goal.
