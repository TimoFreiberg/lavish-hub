# Plan: speed up navigation from published HTML to the hub

## Evidence

The [handoff](slow-html-navigation.md) records a 14.9 ms navigation action followed by an 18.86 MB uncompressed, `no-store` HTML response. The browser spent about 2.03 seconds waiting and 1.27 seconds receiving it. This was one capture on revision `70bed85b`; its waiting time does not identify a server, tunnel, or network cause. The captured handler was not independently confirmed.

`src/hub-runtime.mjs:204-212` embeds both browser bundles in every generated hub page. Existing local `dist/diff-app.js` and `dist/hub-markdown.js` measure 8,368,945 and 10,452,292 bytes. `build.mjs` bundles a worker into the diff script and builds both bundles without minification. The vendored Lavish HTML handlers read the page, inject the SDK and send it uncompressed with `no-store` (`vendor/lavish/src/server.js:2302-2350, 2353-2438`). The source therefore identifies a large avoidable payload, even though it does not prove what caused the captured response wait.

## Implementation

1. Enable esbuild minification for the worker, diff and Markdown browser bundles in `build.mjs`. Build the app and compare generated bundle sizes to the existing sizes above. Keep the current single-file hub generation and inline configuration, scripts and styles. This avoids changing asset URLs, cache authorization, worker delivery or portable export. If minification breaks the embedded worker or rendering, fix that before proceeding.
2. Add negotiated gzip for the vendored Lavish artifact HTML responses after the existing file verification and SDK injection, keeping `Cache-Control: no-store`. Cover both path-addressed and legacy HTML handlers. Use Node's compression facilities, respect `Accept-Encoding` including identity and `gzip;q=0`, set `Vary: Accept-Encoding`, and ensure content length describes the actual response. Do not change caching, authorization, SDK injection, authored asset serving or unrelated responses. Compression is intended to reduce transfer, not assumed to fix response-start latency. If the ordinary Express response path cannot safely support this without compromising those guarantees, report the concrete blocker instead of weakening them.
3. Keep the embedded-worker fallback, authored resources, annotation SDK, navigation confirmations and save-target guards intact. The existing export remains self-contained because the generated HTML still contains its scripts. Verify that actual exported content works rather than assuming this from the design. Do not add a separate benchmark framework, immutable asset service or lazy-loading system for this change.

## Focused verification

- Build using the repository's documented build command. Record resulting diff and Markdown bundle sizes and confirm generated hub HTML still includes its scripts and fresh runtime configuration.
- Add focused tests for gzip negotiation, including gzip, identity and `gzip;q=0`, `Vary`, `no-store`, decompressed equality, SDK injection and the unchanged unauthorized/expired-load behavior. Exercise both artifact HTML handlers. Run the relevant vendored server tests.
- Run the existing hub browser and export tests, adding a focused regression if needed to exercise the minified worker, navigation back from a published HTML page and a self-contained exported hub. Verify authored resources, annotation controls and save-target behavior are unchanged. Run the relevant tests sequentially with isolated temporary state.
- Have the operator run the demo with browser performance monitoring enabled and compare the same published-HTML-to-hub navigation with the prior experience. Record response size and observed timing without recording capability URLs, request bodies, headers, private paths or tokens. No arbitrary numerical target is required. If response start remains slow, report it separately and investigate based on the new trace.

No live restart or reload is authorized by this plan. The operator must explicitly say “restart now” before either action. Do not use `just demo` to restart or reset the existing fixtures and registrations.

## Review and integration

Review the compression change for HTTP negotiation, security and export correctness, and update the relevant documentation if behavior changes. Preserve the delivery guarantees in `docs/feedback-routing.md`. The integrating orchestrator must follow the shared-lock process and run the repository-required `just check`, inspect the screenshot matrix at original size and `status.json`, and report visual inspection separately before integration. This plan does not waive those repository requirements.
