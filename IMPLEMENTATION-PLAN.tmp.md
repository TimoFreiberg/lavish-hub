# Open issues and release QA

Execute with thorough review. Base commit: c0576ffc2767cf6eef3dbbfb1f4051302ded177f.

Approved scope: Audit and make unthemed HTML artifacts dark by default, including development preview and screenshot gallery, preserving explicitly authored themes. Implement on-demand expansion of unchanged lines in the hub Changes diff view using snapshot-pinned file contents, bounded retrieval and a clear fallback for unsupported files. Implement a stable, bookmarkable dashboard accessible through port forwarding listing live hubs, workspace labels and current jj @- summaries, with expiration and no secrets exposed. Follow existing security and delivery guarantees. Do not silently introduce operational prerequisites or scope-changing safeguards; return material tradeoffs to the operator. Update behavior documentation.

Acceptance criteria: unthemed in-scope artifacts render dark independent of OS preference, authored themes remain intact; diff context expands accurately against the displayed pinned snapshot without disrupting feedback or drafts, with safe fallback for unavailable content; dashboard accessible via port forwarding accurately lists live hubs and current summaries, handles expiry and empty states, and does not expose sensitive registration data; uphold existing host and origin protections. Verify each with lasting tests or one-off checks. Include coverage for relevant security and race conditions. Respect repository testing and UI conventions.

Non-goals: revive removed standalone diff commands, override explicitly authored themes, introduce unapproved unrelated features. No temporary tests designated; this plan file is a temporary artifact and must be removed before final delivery.

Delivery: isolated jj workspace, review, project-mandated full just check including screenshot visual inspection and status.json, integrate and non-force push per AGENTS.md, then host just demo for operator manual verification. Do not close issues without operator direction.
