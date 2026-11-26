import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createHubProxy, withHubChrome } from "../src/hub-proxy.js";

test("hub chrome requires both anchors and inserts both elements", () => {
  const brand = '<div class="brand">';
  const frame = '</iframe></div><div class="panel-scrim"';
  const html = withHubChrome(`${brand}</div><iframe></iframe></div><div class="panel-scrim"`, { backIcon: "icon" });
  assert.match(html, /id="hubsLink"[^>]*>icon<span>Hubs<\/span><\/a><div class="brand">/);
  assert.match(html, /<\/iframe><div id="diffCommentOverlay" class="diff-comment-overlay"><\/div><\/div><div class="panel-scrim"/);
  assert.throws(() => withHubChrome(frame, { backIcon: "" }), /brand anchor/);
  assert.throws(() => withHubChrome(brand, { backIcon: "" }), /frame anchor/);
});

test("generated asset registration expires and cannot survive owner replacement or end", async () => {
  const events = new EventEmitter();
  const proxy = createHubProxy({
    store: { findByKey: async () => ({ status: "active" }) },
    events,
    jsonParser: () => {},
  });
  const key = "a".repeat(16);
  const name = `hub-asset-${"b".repeat(64)}.js`;
  const body = {
    key,
    port: 1234,
    capability: "c".repeat(64),
    resourceKey: "d".repeat(64),
    identityKey: "e".repeat(64),
    assets: [name],
  };
  const res = { json: () => {}, status: () => res };
  await proxy.register({ body }, res);
  const first = proxy.generatedAssetRegistration(key, name);
  assert.ok(first);
  first.expires = Date.now() - 1;
  assert.equal(proxy.generatedAssetRegistration(key, name), null);
  await proxy.register({ body }, res);
  assert.equal(proxy.generatedAssetRegistration(key, name), first);
  await proxy.register({ body: { ...body, identityKey: "f".repeat(64) } }, res);
  assert.notEqual(proxy.generatedAssetRegistration(key, name), first);
  events.emit("ended", key);
  assert.equal(proxy.generatedAssetRegistration(key, name), null);
});
