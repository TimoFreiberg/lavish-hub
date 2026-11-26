# Vendored Lavish maintenance

When reviewing or upgrading vendored Lavish, check upstream
[releases](https://github.com/kunchenguid/lavish-axi/releases),
[security advisories](https://github.com/kunchenguid/lavish-axi/security/advisories),
and the [npm package](https://www.npmjs.com/package/lavish-axi), along with
vendored dependencies and the lockfile. Check applicability, fixed versions,
release provenance, and install scripts before installing a candidate. Public
sources and dependency audits will not catch every vulnerability.

`vendor/lavish` is based on
[lavish-axi v0.1.98](https://github.com/kunchenguid/lavish-axi/releases/tag/lavish-axi-v0.1.98),
updated in `bd8ffaccaf3ba8811e62df27b87eb3903aa532c5` from the initial `v0.1.97`
import (`905d0e2f0dbcfb1bb29d65aad90f8b5981a92fa3`) with local patches kept on
top. Those commits record repository history rather than a byte-for-byte check
against the upstream tags.

## Patch ledger

Because `vendor/lavish` keeps the upstream `0.1.98` version string, the version
alone cannot separate a patched server from an older build or a stock
`lavish-axi` process on the same port. `/health` therefore reports the three
capability flags in `HUB_HEALTH_FIELDS` (`vendor/lavish/src/hub-proxy.js`):
`lavish_hub_page_reviews`, `lavish_hub_assets`, and `lavish_hub_batch_replies`.
`src/lavish-http.mjs` refuses any server missing one (`test/lavish-http.test.mjs`).
The remaining hub and transport patches below have no separate `/health` flag.

### Page-scoped reviews (PR #363 port)

A hub session opens `hub.html` as its canonical entry file and serves published
HTML artifacts as sibling pages in the same session, so feedback, persisted
review state, layout warnings, and whiteboards must stay scoped to each
authenticated page rather than colliding on the entry file. Local commit
`70cb1ada946b295b24481bb2d14d56405cab8d31` ports that model from
[upstream PR #363](https://github.com/kunchenguid/lavish-axi/pull/363) (and may
diverge from the PR's current head).

Under `vendor/lavish/src/`, the port touches `artifact-page.js`,
`verified-local-file.js`, `artifact-sdk.js`, `chrome-client.js`, `server.js`,
`session-store.js`, `layout-warnings.js`, `whiteboard-store.js`, `cli.js`,
`chat-messages.js`, `export-bundle.js`, and `html-transform.js`. It reports
`lavish_hub_page_reviews: 1` on `/health`. Pinning tests include
`artifact-page.test.js`, `page-proof.test.js`, `page-feedback-batches.test.js`,
`page-delivery-receipts.test.js`, `protected-artifact-source.test.js`,
`server-issue-352-routing.test.js`, and `issue-352-review.browser.test.js` under
`vendor/lavish/test/`, plus `test/hub-vendored.test.mjs`.

### Hub-only patches

- `vendor/lavish/src/hub-proxy.js` implements the authenticated hub proxy and
  exports `createHubProxy`, `mountHubRoutes`, `HUB_HEALTH_FIELDS`, and
  `withHubChrome`. `vendor/lavish/src/hub-dashboard.js` supplies `hubDashboard`
  for `/hubs`, and `vendor/lavish/src/server.js` redirects `/` to `/hubs`.
  `mountHubRoutes` installs `/hubs`, `/api/hubs`, `/api/hub-proxy/register`,
  `/api/hub-proxy/unregister`, and `/hub-proxy`. In `server.js`, it must run
  after the `Host` allowlist (so untrusted `Host` headers are still rejected)
  and before the same-origin `Origin`/`Referer` guard, which would otherwise
  reject `POST /hub-proxy/:key/action` from the opaque-origin (`Origin: null`)
  artifact iframe before `createHubProxy` can check `x-lavish-capability`.
  `withHubChrome` injects `hubsLink` and `diffCommentOverlay` into the session
  chrome HTML and throws if either template anchor moves. Pinning tests:
  `test/hub-proxy.test.mjs`, `vendor/lavish/test/hub-proxy-deadlines.test.js`,
  `vendor/lavish/test/hub-asset-registration.test.js`, and
  `test/hub-vendored.test.mjs`.
- The hub runs inside a sandboxed (`Origin: null`) artifact iframe and fetches
  its ES module bundles (`hub-asset-<hash>.js`) across origins from
  `/artifact/:key/...`. `vendor/lavish/src/hub-assets.js` (`createHubAssets`)
  verifies registered JavaScript assets, compresses HTML and asset responses
  with bounded coalescing and caching, and grants
  `Access-Control-Allow-Origin: null` on verified 200 and 304 asset responses
  when `Origin: null`. Keep `Vary: Origin` on every variant so caches do not mix
  responses across origins, and keep the grant off errors, byte ranges, and
  unregistered files so opaque-origin frames cannot read arbitrary sibling
  files. The server reports `lavish_hub_assets: 1` on `/health`. Pinning tests:
  `vendor/lavish/test/server.test.js`,
  `vendor/lavish/test/hub-asset-registration.test.js`, and
  `test/hub-vendored.test.mjs`.
- On `/session/:key`, `vendor/lavish/src/server.js` validates `?view=` into
  `initialView` along with `file`, `line`, `side`, and `change` in
  `initialViewParams`. `vendor/lavish/src/chrome-client.js` forwards them once
  to the artifact frame as `__lavish_hub_view` and matching `__lavish_hub_*`
  parameters, then strips them from stored destinations and the outer URL so
  reloads and later page switches do not jump back to the initial target.
  Pinning tests: `vendor/lavish/test/server.test.js`,
  `vendor/lavish/test/chrome-client-queue.test.js`, and
  `test/hub-vendored.test.mjs`.
- `vendor/lavish/src/artifact-sdk.js` and `vendor/lavish/src/chrome-client.js`
  extend `window.lavish` and the authenticated frame protocol for hub views and
  sibling HTML pages (`web/hub-app.mjs`, `web/diff-app.mjs`,
  `web/hub-lifecycle.js`, and `src/hub-html.mjs`). The SDK dispatches
  `lavish:ready` when initialized. `setAnnotationMode` toggles the chrome switch
  for the interactive `Diff` view and resolves on acknowledgment or returns
  `false` after one second. `syncUrl` (`lavish:syncUrl` and
  `lavish:urlChange`), `setDocumentMeta`, and `navigateFrame` keep the outer
  URL, tab title, and history draft guard aligned across frame navigations, and
  `requestDiffAnchors`, `reportDiffPlacements`, and `lavish:queuedDiffAnchors`
  drive inline diff comment markers. Pinning tests:
  `vendor/lavish/test/chrome-client-queue.test.js`,
  `test/hub-refresh-browser.test.mjs`, `test/hub-url-sync-browser.test.mjs`, and
  `test/hub-vendored.test.mjs`.
- `vendor/lavish/src/server.js` and `vendor/lavish/src/session-store.js` return
  `batch_id` from consuming polls and retain up to 50 `delivered_batches` per
  session so `POST /api/:key/agent-reply` stamps `Done` only on that batch's
  prompts instead of closing newer batches the agent has not handled yet.
  Preserve disconnected-poll restoration, bounded batch eviction, and legacy
  unbound replies (`batch_id` omitted). Unknown and duplicate batches return
  `404 BATCH_NOT_FOUND` and `409 BATCH_ALREADY_REPLIED`. The server reports
  `lavish_hub_batch_replies: 1` on `/health`. Pinning tests:
  `vendor/lavish/test/server.test.js` and `test/lavish-http.test.mjs`. See
  [the HTTP boundary](lavish-http.md#batch-replies) and
  [delivery guarantees](feedback-routing.md#delivery-guarantees).
- `vendor/lavish/src/server-diagnostics.js` exports `createServerDiagnostics`
  and `markServerDiagnostic` for request-stage timing logs without paths, keys,
  headers, or bodies. When `LAVISH_HUB_DIAGNOSTICS=1`, `server.js` mounts the
  middleware and `hub-proxy.js` logs proxy stages. Pinning tests:
  `test/server-diagnostics.test.mjs` and `test/hub-diagnostics.test.mjs`.

### Transport resilience patches

- `vendor/lavish/src/server.js` sets `res.shouldKeepAlive = false` so every HTTP
  response carries `Connection: close`. Port forwarders that do not relay
  server-side closes otherwise leave dead sockets in the browser's pool until
  per-origin connection slots fill and navigations stall. Pinning test:
  `vendor/lavish/test/server.test.js`.
- `vendor/lavish/src/server.js` sends live-event WebSocket `heartbeat` messages
  every 30 seconds, and `vendor/lavish/src/chrome-client.js` replaces the socket
  after 75 seconds of silence (`LIVE_EVENT_SILENCE_LIMIT_MS`) so half-open
  forwarded sockets recover. Pinning tests:
  `vendor/lavish/test/server-bind-durability.test.js` and
  `vendor/lavish/test/chrome-client-queue.test.js`.
- `vendor/lavish/src/chrome-client.js` bounds recovery `/health` probes
  (`HEALTH_PROBE_TIMEOUT_MS`) and artifact-availability probes
  (`ARTIFACT_AVAILABILITY_PROBE_TIMEOUT_MS`) with abort timeouts so hung
  requests release UI controls and connection slots. Pinning test:
  `vendor/lavish/test/chrome-client-queue.test.js`.
- `vendor/lavish/src/artifact-sdk.js` caps layout retries
  (`WHITEBOARD_LAYOUT_RETRY_LIMIT`) for zero-height Mermaid diagrams and
  switches to `watchWhiteboardLayout` so hidden diagrams wait for a later reveal
  instead of polling for the life of the tab. Pinning test:
  `vendor/lavish/test/artifact-sdk-bundle.test.js`.

### Upstream v0.1.98 features (not local patches)

PR #363 branched before upstream `v0.1.98` landed several features now in
`vendor/lavish`. When diffing against PR #363, do not mistake these upstream
additions for local patches:

- `refuseNonHtmlArtifact`, `resolveBrowserDisconnectGraceMs`, and the
  comment-safe `<title>` scan in `extractArtifactHead`, all in
  `vendor/lavish/src/server.js`.
- `resolveAllowedArtifactFile` in `vendor/lavish/src/artifact-path.js`, plus
  whiteboard libraries in `vendor/lavish/src/whiteboard-libraries.js` and
  `vendor/lavish/src/whiteboard-library-store.js`.
- `markWorking` and `delivery_seq` in `vendor/lavish/src/session-store.js`, and
  `publishChatSync` in `vendor/lavish/src/server.js` (the batch-reply patch
  above builds on this upstream delivery bookkeeping).
- The desktop `sidebarToggle` in `vendor/lavish/src/chrome-client.js`.

## Upgrade procedure

Do not drop a patch just because PR #363 merges or a new upstream release
appears. Compare the candidate's source and runtime behavior against each item
above, keeping or adapting any page-review, routing, or hub behavior still
needed here. Retire local code only after confirming an upstream equivalent and
passing regression tests and full repository QA, including visual inspection.
Review and document upgrades in their own change.
