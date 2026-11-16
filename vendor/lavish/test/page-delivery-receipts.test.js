import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStore } from "../src/session-store.js";

test("page batches stamp only delivered notes and restore their identities", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-receipts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const artifact = path.join(dir, "index.html");
  await writeFile(artifact, "hello");
  const store = new SessionStore(path.join(dir, "state.json"));
  const { key } = await store.upsertSession(artifact, "http://localhost/session/test");
  for (const page of ["a.html", "b.html"]) {
    await store.queuePrompts(key, { page_protocol: 1, prompts: [{ tag: "message", prompt: page, page }] });
  }
  // Simulate pending batches written by a version before receipt identities.
  const stateFile = path.join(dir, "state.json");
  const legacy = JSON.parse(await readFile(stateFile, "utf8"));
  for (const batch of legacy.sessions[key].feedback_batches) {
    for (const prompt of batch.prompts) delete prompt.receipt_id;
  }
  for (const entry of legacy.sessions[key].chat) delete entry.receipt_id;
  await writeFile(stateFile, JSON.stringify(legacy));
  const first = await store.takeFeedback(key);
  assert.equal(first.prompts[0].page, "a.html");
  assert.equal(first.prompts[0].receipt_id, undefined);
  let chat = (await store.readState()).sessions[key].chat;
  assert.ok(chat[0].delivered_at);
  assert.equal(chat[1].delivered_at, undefined);
  await store.queuePrompts(key, first, { restore: true });
  chat = (await store.readState()).sessions[key].chat;
  assert.equal(chat[0].delivered_at, undefined);
  await store.takeFeedback(key);
  chat = (await store.readState()).sessions[key].chat;
  assert.ok(chat[0].delivered_at);
  assert.equal(chat[1].delivered_at, undefined);
  await store.takeFeedback(key);
  chat = (await store.readState()).sessions[key].chat;
  assert.ok(chat[1].delivered_at);
});
