import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";
import { createHubProxy } from "../src/hub-proxy.js";

const KEY = "a".repeat(16);
const RESOURCE_KEY = "d".repeat(64);
const CAPABILITY = "c".repeat(64);
const IDENTITY_KEY = "e".repeat(64);
const registration = {
  key: KEY,
  port: 1234,
  capability: CAPABILITY,
  resourceKey: RESOURCE_KEY,
  identityKey: IDENTITY_KEY,
  assets: [],
};

// The handler writes its answer through the response object, so the test observes the very call
// the browser would. `answered` and `tornDown` exist because the two outcomes a deadline can
// produce are a status the browser reads and a socket it loses, and they are never both. `bodies`
// records every write, and `json` throws on a second one the way `ServerResponse` does, so a late
// resolution cannot quietly answer a request twice.
function fakeResponse() {
  const response = {
    statusCode: undefined,
    headersSent: false,
    destroyed: false,
    ended: false,
    bodies: [],
    answered: undefined,
    tornDown: undefined,
    once() {},
    removeListener() {},
    set() {
      return response;
    },
    status(code) {
      response.statusCode = code;
      return response;
    },
    end() {
      response.headersSent = true;
      response.ended = true;
      return response;
    },
    json(body) {
      if (response.headersSent) throw new Error("Cannot set headers after they are sent");
      response.headersSent = true;
      response.ended = true;
      response.bodies.push(body);
      response.answered?.(response);
      return response;
    },
    destroy() {
      response.destroyed = true;
      response.tornDown?.(response);
    },
  };
  return response;
}

// The first lookup registers the target; every later one answers a promise that never settles,
// which is the store's mutex staying parked for the life of the request.
function stalledLookupStore() {
  let calls = 0;
  return {
    findByKey() {
      calls += 1;
      return calls === 1 ? Promise.resolve({ status: "active" }) : new Promise(() => {});
    },
  };
}

// The other half of a stuck mutex: it does let go, after the request has already been answered.
// Call 1 registers, call 2 is the request's own lookup, and every other call answers at once.
function lateLookupStore(delayMs = 40) {
  let calls = 0;
  let release;
  const answered = new Promise((resolve) => {
    release = resolve;
  });
  return {
    answered,
    findByKey() {
      calls += 1;
      if (calls !== 2) return Promise.resolve({ status: "active" });
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({ status: "active" });
          release();
        }, delayMs);
      });
    },
  };
}

async function proxyWith(store, limits) {
  const events = new EventEmitter();
  const proxy = createHubProxy({ store, events, jsonParser: () => {}, limits });
  await proxy.register({ body: registration }, fakeResponse());
  return proxy;
}

// The outcome has to arrive on its own, so a regression fails this test instead of hanging it.
async function within(promise, ms = 2000) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve("no outcome"), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function getRequest(url) {
  const request = {
    method: "GET",
    originalUrl: url,
    headers: {},
    complete: true,
    destroyed: false,
    destroy() {
      request.destroyed = true;
    },
  };
  return request;
}

function postActionRequest() {
  const request = {
    method: "POST",
    originalUrl: `/hub-proxy/${KEY}/action`,
    headers: { "content-type": "application/json", "x-lavish-capability": CAPABILITY },
    // A body that was never read: the lookup is stuck, so nothing has consumed it.
    complete: false,
    destroyed: false,
    destroy() {
      request.destroyed = true;
    },
  };
  return request;
}

// The session lookup happens before anything is forwarded, and it waits on the store's own mutex.
// A resource read that cannot get an identity must still answer, or the browser holds the
// connection open until the user navigates away.
test("a resource read stuck in the session lookup answers instead of holding the connection", async () => {
  const proxy = await proxyWith(stalledLookupStore(), { lookupMs: 5 });
  const res = fakeResponse();
  const answered = new Promise((resolve) => {
    res.answered = resolve;
  });

  proxy.handle(getRequest(`/hub-proxy/${KEY}/resources/${RESOURCE_KEY}/assets/app.css`), res);
  const outcome = await within(answered);

  assert.notEqual(outcome, "no outcome", "the request answers without the store ever resolving");
  assert.equal(res.statusCode, 502, "a lookup that never resolved says nothing about the owner");
  assert.deepEqual(res.bodies, [{ error: "Hub unavailable" }]);
  assert.equal(res.ended, true, "the connection is released rather than left open");
  assert.equal(res.destroyed, false, "and the status reaches the browser instead of a reset");
});

// A mutation keeps its teardown: the browser must not learn from a status that an action it may
// still have had delivered was refused.
test("a mutation stuck in the same lookup keeps its socket teardown", async () => {
  const proxy = await proxyWith(stalledLookupStore(), { actionMs: 5 });
  const res = fakeResponse();
  const tornDown = new Promise((resolve) => {
    res.tornDown = resolve;
  });
  const req = postActionRequest();

  proxy.handle(req, res);
  const outcome = await within(tornDown);

  assert.notEqual(outcome, "no outcome", "the request is dropped without the store ever resolving");
  assert.equal(res.headersSent, false, "a mutation deadline still reports no status");
  assert.equal(res.destroyed, true, "the connection is torn down");
  assert.equal(req.destroyed, true, "and the unread body is dropped with it");
});

// The store does let go eventually. By then the request has been answered, so the handler resumes
// on an aborted controller: it must return without writing over that answer or tearing down the
// socket the browser is reading.
test("a lookup that resolves after its deadline writes nothing further", async () => {
  const store = lateLookupStore();
  const proxy = await proxyWith(store, { lookupMs: 5 });
  const res = fakeResponse();
  const answered = new Promise((resolve) => {
    res.answered = resolve;
  });

  const handled = proxy.handle(getRequest(`/hub-proxy/${KEY}/resources/${RESOURCE_KEY}/assets/app.css`), res);
  await within(answered);
  assert.equal(res.statusCode, 502, "the deadline answered first");

  await within(store.answered, 1000);
  await within(handled, 1000);

  assert.deepEqual(res.bodies, [{ error: "Hub unavailable" }], "the answer is written once");
  assert.equal(res.statusCode, 502, "and its status is not overwritten");
  assert.equal(res.destroyed, false, "the socket it was written on stays");
});

// The sharpest ordering: the lookup resolves after the owner re-registered, so the retired-target
// branch runs with a response already sent. It must retire the target without answering again.
test("a lookup that resolves onto a replaced target does not answer twice", async () => {
  const store = lateLookupStore();
  const proxy = await proxyWith(store, { lookupMs: 5 });
  const res = fakeResponse();
  const answered = new Promise((resolve) => {
    res.answered = resolve;
  });

  const handled = proxy.handle(getRequest(`/hub-proxy/${KEY}/resources/${RESOURCE_KEY}/assets/app.css`), res);
  await within(answered);

  // A re-registration replaces the target this request arrived with.
  await proxy.register({ body: { ...registration, port: 12345 } }, fakeResponse());

  await within(store.answered, 1000);
  await within(handled, 1000);

  assert.deepEqual(res.bodies, [{ error: "Hub unavailable" }], "the stale-target 404 is not written over it");
  assert.equal(res.statusCode, 502, "the status the browser already has does not change");
  assert.equal(res.destroyed, false, "and the socket is not torn down");
});

// An owner that proves its identity and then never answers the forwarded request, which is the
// wedged-owner case the resource deadline exists for. `identityDelayMs` stretches the challenge
// round trip so a test can tell it apart from the lookup that came before it.
function ownerWith({ identityDelayMs = 0 } = {}) {
  const calls = [];
  const upstream = http.createServer((req, res) => {
    const identity = /^\/identity\/([a-f0-9]{64})$/.exec(req.url || "");
    if (!identity) {
      calls.push("forward");
      return;
    }
    calls.push("identity");
    setTimeout(() => {
      const proof = crypto.createHmac("sha256", IDENTITY_KEY).update(identity[1]).digest("hex");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ proof }));
    }, identityDelayMs);
  });
  return { calls, upstream };
}

async function resourceReadThrough(owner, limits) {
  await new Promise((resolve) => owner.upstream.listen(0, "127.0.0.1", resolve));
  try {
    const proxy = await proxyWith({ findByKey: async () => ({ status: "active" }) }, limits);
    await proxy.register({ body: { ...registration, port: owner.upstream.address().port } }, fakeResponse());
    const res = fakeResponse();
    const answered = new Promise((resolve) => {
      res.answered = resolve;
    });
    proxy.handle(getRequest(`/hub-proxy/${KEY}/resources/${RESOURCE_KEY}/assets/app.css`), res);
    const outcome = await within(answered);
    assert.notEqual(outcome, "no outcome", "a resource read always answers");
    return res;
  } finally {
    owner.upstream.closeAllConnections();
    await new Promise((resolve) => owner.upstream.close(resolve));
  }
}

// The lookup deadline has to be replaced once the request forwards, not left to fire behind the
// phase that supersedes it. A stale lookup timer would answer 502 early, and the 504 that means
// "the owner never started answering" would never leave the process.
test("the lookup deadline is replaced rather than left to fire once a resource forwards", async () => {
  const owner = ownerWith();
  const res = await resourceReadThrough(owner, { lookupMs: 5, resourceMs: 20 });

  assert.equal(res.statusCode, 504, "only the post-forward deadline can report a wedged owner");
  assert.deepEqual(res.bodies, [{ error: "Hub timeout" }]);
  assert.deepEqual(owner.calls, ["identity", "forward"], "the resource read was forwarded before it failed");
  assert.equal(res.destroyed, false, "a resource read keeps its socket so the status arrives");
});

// The identity challenge is bounded by its own budget, so a slow challenge must not be charged to
// the lookup deadline in front of it: they fail differently, and only a lookup failure says
// anything about the store.
test("a slow identity challenge is not charged to the lookup budget", async () => {
  const owner = ownerWith({ identityDelayMs: 100 });
  const res = await resourceReadThrough(owner, { lookupMs: 50, resourceMs: 20 });

  assert.deepEqual(owner.calls, ["identity", "forward"], "the challenge completed after the lookup budget");
  assert.equal(res.statusCode, 504, "the failure came from the resource deadline, not the lookup");
});
