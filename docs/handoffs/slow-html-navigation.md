# Handoff: slow navigation from published HTML to the hub

## Goal and boundaries

Investigate why navigating from a published Review HTML document to a built-in hub view feels slow. Direct navigation among built-in views is fast, and repeating the transition with a warm cache did not help. This handoff is evidence and a suggested investigation sequence, not an approved implementation plan.

The private Chrome captures are `$HOME/Trace-20261117T205110.json.gz` and `$HOME/slow-navigation.har`. The user authorizes local analysis. Do not publish the captures or read raw secrets; do not quote request or response bodies, headers, tokens, or capability URLs. The measurements below come from a prior read-only analysis, not a new inspection for this handoff.

## Captured evidence

The capture measured live revision `70bed85b4b7c9fb56c8c7b51ef597ac00715ab79`. Pending revision `ba1b53cd01ce97e387cac86984ca77b5dd1b3479` was not live and cannot explain this trace.

In the HAR, relative to its first request:

- Status and documents requests started at 0 and 2,029 ms and were fast and parallel.
- The navigation POST started at 2,123 ms, took 14.9 ms, and spent 5.7 ms waiting.
- The hub GET started at 2,140 ms, returned 200, and took 3,301.4 ms: 2,026.4 ms waiting and 1,273.9 ms receiving. It transferred 18,859,821 bytes, with 18,859,437 decoded bytes. The response was HTML, marked `no-store`, and had no content encoding; there were no redirects.
- The document contained about 18,843,407 script characters, including inline blocks of 8,368,916 and 10,452,288 characters. An offline gzip of the whole document was 3,499,453 bytes; this is illustrative, not a measured runtime speedup.

In the trace, response start was 2,029.5 ms after navigation start, response completion 3,419.9 ms, DOMContentLoaded 3,457.4 ms, and first contentful paint 3,474.8 ms. Two ParseHTML events took 95.2 and 118.4 ms, with nested EvaluateScript events of 86.9 and 108.5 ms; do not add the nested times. Across the capture, parse totaled 336.5 ms and evaluation 267.1 ms with overlap; layout totaled 9.5 ms. Waiting for the response and receiving it dominate this transition, rather than CPU work alone.

The roughly 800 ms user action was a snapshot POST starting at 5,625 ms, after first contentful paint; it took 824.4 ms, including 816 ms waiting. Later snapshots took 533–759 ms. Treat snapshot latency as separate work. Browser wait and receive times cannot distinguish server, SSH, proxy, network, or disk costs. There is no proof that the two-second selection poll causes the direct click delay. An earlier isolated navigation response was about 45 ms while the full heading appeared in 3.5–6.4 seconds; that argues against an SSH-only explanation but does not establish a root cause.

## Source starting points

At `src/hub-runtime.mjs:139`, the published HTML sidebar click awaits the `navigate` action before setting `location.href`. At lines 179–186, `select` validates the ID and updates the selected value. At lines 204–210, the generated hub HTML embeds `dist/diff-app.js` and `dist/hub-markdown.js` inline.

`src/hub-transport.mjs:21–39` has an owner resource route that reads full files and sends them with `no-store` and no compression. It is **not established** that this route served the captured hub HTML. First trace the actual vendored Lavish document-serving path, distinguishing the owner action/resource service from Lavish serving the page on port 4388. Inspect `build.mjs` and browser/worker bundling as possible sources of the payload, not as established causes.

## Suggested next investigation

1. Trace the served document from generated file to the actual Lavish response. Instrument safe server timings for request arrival, file read or generation, headers, finish, and byte counts. Do not log secrets, bodies, or capability URLs. Compare repeated warm local and tunneled requests to separate costs where possible.
2. Identify why the bundles are so large. Profile the same published-HTML-to-hub transition before and after any candidate change. Compression may reduce transfer bytes; it is not a demonstrated fix for time to first byte.
3. Assess compressed, versioned, cacheable public static assets against inline per-page code and lazy loading. Keep capability-bearing and private page content `no-store` unless separately justified; cache only safe immutable assets. Do not apply a sweeping cache policy. Preserve fresh configurations, authored HTML resources, worker URLs, macOS and Linux support, export portability, the annotation SDK, and save-target guards.
4. Cover byte size, content encoding, caching and bundle URLs, as well as authored pages, workers and relevant behavior in tests. Measure the same transition again rather than inferring user-visible gains from offline compression.

## Interactive session state and safety

The source task began at `df397a5821b0b52189e77b2a913a4ec9063ff564` in the existing jj workspace `.workspaces/interactive-commits`. Do not clean up that workspace: it contains the task and the live runtime uses it. No integration or push has happened. Full QA was explicitly deferred during the interactive workflow; run the repository's full QA before final integration unless the user gives a fresh override.

The demo service is `interactive-demo-v4` in session `0gbk9p-deaf`, built from `70bed85b`. Lavish uses port 4388 and the action service used port 64069; the latter is ephemeral, so verify it in the next session. Retained data is in `$HOME/.cache/lavish-kit-demo`, and the populated base configuration has already been applied. Preserve fixtures and registrations.

**Never restart or reload until the user explicitly says “restart now.”** The previous authorization was consumed. Restarting or reloading may lose queued or dictated comments. Do not invoke `just demo` to restart: it regenerates and resets fixtures.

Pending `ba1b53cd` adds the actual toggle setter through a new authenticated vendored SDK API, 120-character non-wrapping descriptions, full-width Changes, and hides Ready. It has not been deployed or reviewed. Previously, targeted checks passed for 10 hub, 1 preview, and 2 vendored cases; typecheck failed because `tsc` was missing. These are prior results, not new verification by this handoff.

The normal parent workflow is subagent implementation, an explicitly authorized preview restart, then background thorough correctness and leanness reviews, with targeted checks during iteration and full QA and integration deferred until the end. Four low-priority leanness cleanups remain unrelated to this investigation: a stale preview initializer, an unreachable document/tasks `else`, a duplicate insertion-point chain, and commit-named shared controls. Do not expand this handoff's scope to implement them.
