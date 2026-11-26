import crypto from "node:crypto";
import http from "node:http";
import { markServerDiagnostic } from "./server-diagnostics.js";
import { hubDashboard } from "./hub-dashboard.js";

export const HUB_HEALTH_FIELDS = {
  lavish_hub_page_reviews: 1,
  lavish_hub_batch_replies: 1,
  lavish_hub_assets: 1,
};

/** @param {any} app @param {any} hubProxy */
export function mountHubRoutes(app, hubProxy) {
  app.get("/hubs", (req, res) =>
    res
      .set({
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "frame-ancestors 'none'",
      })
      .type("html")
      .send(hubDashboard),
  );
  app.get("/api/hubs", hubProxy.dashboard);
  app.post("/api/hub-proxy/register", hubProxy.control, hubProxy.register);
  app.post("/api/hub-proxy/unregister", hubProxy.control, hubProxy.unregister);
  app.use("/hub-proxy", hubProxy.handle);
}

/** @param {string} html @param {{backIcon: string}} options */
export function withHubChrome(html, { backIcon }) {
  const brand = '<div class="brand">';
  const frame = '</iframe></div><div class="panel-scrim"';
  if (!html.includes(brand)) throw new Error("Hub chrome brand anchor missing");
  if (!html.includes(frame)) throw new Error("Hub chrome frame anchor missing");
  return html
    .replace(brand, `<a class="hubs-link" id="hubsLink" href="/hubs" title="Active hubs">${backIcon}<span>Hubs</span></a>${brand}`)
    .replace(frame, '</iframe><div id="diffCommentOverlay" class="diff-comment-overlay"></div></div><div class="panel-scrim"');
}

const secretPattern = /^[a-f0-9]{64}$/;
const sessionPattern = /^[a-f0-9]{16}$/;
const sandbox = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads";
const maxBody = 64 * 1024;
// Deadlines are per phase, never one shared total. The identity challenge is
// bounded on its own for every request, so tightening a later phase cannot
// silently budget an extra round trip into it. A mutation keeps one ceiling from
// receipt, because abandoning it early hides whether it was delivered, while a
// resource read only has to start answering quickly: a longer wait means a
// wedged owner. The session lookup runs before either of them and waits on the
// store's own mutex, so it needs a bound too - no owner contact is bounded by a
// phase that can stall on local state.
const defaultLimits = { actionMs: 120000, lookupMs: 10000, resourceMs: 20000, identityMs: 5000 };

function validateDisplay(display) {
  const validText = (value, max) =>
    typeof value === "string" &&
    Array.from(value).length <= max &&
    !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  const optionalText = (value, max) => value == null || validText(value, max);
  return (
    display &&
    typeof display === "object" &&
    !Array.isArray(display) &&
    validText(display.label, 255) &&
    display.label.trim().length > 0 &&
    (display.summary === null || (typeof display.summary === "string" && display.summary.length <= 240)) &&
    optionalText(display.repo, 255) &&
    optionalText(display.workspace, 64) &&
    (display.startedAt === undefined || (Number.isSafeInteger(display.startedAt) && display.startedAt >= 0)) &&
    (display.unread === undefined ||
      (Array.isArray(display.unread) &&
        display.unread.length <= 50 &&
        display.unread.every(
          (item) =>
            item &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            typeof item.id === "string" &&
            /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(item.id) &&
            validText(item.title, 255) &&
            item.title.trim().length > 0,
        )))
  );
}

function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function localControl(req) {
  return (
    ["127.0.0.1", "::ffff:127.0.0.1", "::1"].includes(req.socket.remoteAddress) &&
    !req.headers.origin &&
    !req.headers.referer &&
    !req.headers["x-forwarded-for"] &&
    !req.headers["x-forwarded-host"]
  );
}

// The authenticated socket is the identity boundary, not the reusable port number.
class SingleSocketAgent extends http.Agent {
  used = false;
  createConnection(options, callback) {
    if (this.used) {
      queueMicrotask(() => callback(new Error("Hub connection closed")));
      return undefined;
    }
    this.used = true;
    return super.createConnection(options, callback);
  }
}

function upstreamRequest(agent, port, pathname, method, headers, body, signal) {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = http.request({ host: "127.0.0.1", port, path: pathname, method, headers, agent, signal }, resolve);
    } catch (error) {
      reject(error);
      return;
    }
    request.on("error", reject);
    request.end(body);
  });
}

async function authenticatedRequest(target, pathname, method, headers, body, signal, isCurrent, onForward, identityMs) {
  const agent = new SingleSocketAgent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  const close = () => agent.destroy();
  signal.addEventListener("abort", close, { once: true });
  try {
    if (signal.aborted) throw new Error("Hub request cancelled");
    const challenge = crypto.randomBytes(32).toString("hex");
    // Nothing has been forwarded yet, so a silent owner only costs this bound.
    const proof = await upstreamRequest(
      agent,
      target.port,
      `/identity/${challenge}`,
      "GET",
      {},
      undefined,
      AbortSignal.any([signal, AbortSignal.timeout(identityMs)]),
    );
    let text = "";
    for await (const chunk of proof) {
      text += chunk;
      if (text.length > 1024) throw new Error("Invalid hub identity");
    }
    const expected = crypto.createHmac("sha256", target.identityKey).update(challenge).digest("hex");
    if (proof.statusCode !== 200 || !equal(JSON.parse(text).proof, expected)) throw new Error("Invalid hub identity");
    if (!isCurrent()) throw Object.assign(new Error("Hub unavailable"), { code: "HUB_TARGET_CHANGED" });
    onForward();
    const response = await upstreamRequest(agent, target.port, pathname, method, headers, body);
    return {
      response,
      close: () => {
        signal.removeEventListener("abort", close);
        close();
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", close);
    close();
    throw error;
  }
}

export function createHubProxy({ store, events, jsonParser, limits = undefined }) {
  const bounds = { ...defaultLimits, ...(limits || {}) };
  const targets = new Map();
  const pending = new Set();
  let diagnosticId = 0;
  events.on("ended", (key) => {
    targets.delete(key);
    for (const registration of pending) if (registration.key === key) registration.ended = true;
  });
  const control = (req, res, next) => {
    if (!localControl(req)) return res.status(403).json({ error: "Local control required" });
    return jsonParser(req, res, next);
  };
  const register = async (req, res) => {
    const { key, port, capability, resourceKey, identityKey, assets = [], display } = req.body || {};
    if (
      !sessionPattern.test(key || "") ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      ![capability, resourceKey, identityKey].every(
        (value) => typeof value === "string" && secretPattern.test(value),
      ) ||
      !Array.isArray(assets) ||
      assets.length > 3 ||
      !assets.every((name) => typeof name === "string" && /^hub-asset-[a-f0-9]{64}\.js$/.test(name)) ||
      (display !== undefined && !validateDisplay(display))
    ) {
      return res.status(400).json({ error: "Invalid registration" });
    }
    for (const existing of pending) if (existing.key === key) existing.ended = true;
    const registration = { key, identityKey, ended: false };
    pending.add(registration);
    let session;
    try {
      session = await store.findByKey(key);
    } finally {
      pending.delete(registration);
    }
    if (session?.status === "ended")
      return res.status(404).json({ code: "HUB_SESSION_ENDED", error: "Session not active" });
    if (registration.ended || !session) return res.status(404).json({ error: "Session not active" });
    const target = targets.get(key);
    const registeredAt = target && target.expires > Date.now() ? target.registeredAt : Date.now();
    if (
      !target ||
      target.port !== port ||
      target.capability !== capability ||
      target.resourceKey !== resourceKey ||
      target.identityKey !== identityKey ||
      JSON.stringify(target.assets) !== JSON.stringify(assets)
    ) {
      targets.set(key, { port, capability, resourceKey, identityKey, assets });
    }
    const current = targets.get(key);
    current.registeredAt = registeredAt;
    current.display = display
      ? {
          label: display.label,
          summary: display.summary,
          repo: display.repo ?? null,
          workspace: display.workspace ?? null,
          startedAt: display.startedAt ?? registeredAt,
          unread: (display.unread || []).map(({ id, title }) => ({ id, title })),
        }
      : null;
    current.expires = Date.now() + 45000;
    return res.json({ ok: true });
  };
  const unregister = (req, res) => {
    const { key, identityKey } = req.body || {};
    const target = targets.get(key);
    if (target && equal(target.identityKey, identityKey)) targets.delete(key);
    for (const registration of pending)
      if (registration.key === key && equal(registration.identityKey, identityKey)) registration.ended = true;
    return res.json({ ok: true });
  };
  const handle = async (req, res) => {
    /** @type {(event: string, status?: number) => void} */
    let log = () => {};
    if (process.env.LAVISH_HUB_DIAGNOSTICS === "1") {
      const id = ++diagnosticId,
        start = Date.now(),
        method = req.method;
      log = (event, status) => {
        // Stage and status only: paths, keys, headers and bodies never leave the
        // process, including on the failure paths added below.
        try {
          console.error(
            JSON.stringify({
              diagnostic: "hub",
              side: "proxy",
              id,
              method,
              event,
              time: new Date().toISOString(),
              elapsedMs: Date.now() - start,
              ...(status === undefined ? {} : { status }),
            }),
          );
        } catch {
          // Diagnostics logging is best-effort.
        }
      };
      log("arrive");
      res.once("finish", () => log("finish", res.statusCode));
      res.once("close", () => log("close", res.statusCode));
    }
    const originalUrl = req.originalUrl || "";
    const queryIndex = originalUrl.indexOf("?");
    const pathname = queryIndex === -1 ? originalUrl : originalUrl.slice(0, queryIndex);
    const query = queryIndex === -1 ? "" : originalUrl.slice(queryIndex);
    const match = /^\/hub-proxy\/([a-f0-9]{16})(\/.*)$/.exec(pathname);
    if (!match) return res.status(404).json({ error: "Not found" });
    const [, key, route] = match;
    const target = targets.get(key);
    if (!target || target.expires <= Date.now()) {
      if (target && targets.get(key) === target) targets.delete(key);
      return res.status(404).json({ error: "Hub unavailable" });
    }
    if (req.headers.origin && req.headers.origin !== "null") return res.status(403).json({ error: "Invalid origin" });
    // Watch for a departed client before the lookup. Otherwise the owner is
    // asked to authenticate and dispatch for a response nobody can read, and a
    // socket that already closed never emits the later events this handler waits
    // on, so the request stalls until its overall bound expires.
    const controller = new AbortController();
    // Set only by a deadline that answers the request, and never cleared: the abort it is followed
    // by must not tear down a socket this handler already wrote to, so clearing it once the response
    // exists would turn the next abort into a reset. Any new setter has to call `stop()` too.
    let close,
      timeout,
      answerableDeadline = false;
    const stop = () => controller.abort();
    // A deadline that fires while a response can still be written must not tear
    // the socket down, or the failure reaches the browser as a reset with no
    // status. Mutations keep the existing teardown so their observable outcome
    // does not change.
    const expireAnswerable = () => {
      // The client may already be gone: its cleanup runs first, and a disconnect
      // must never be reported as a timeout.
      if (controller.signal.aborted) return;
      answerableDeadline = true;
      stop();
    };
    // One slot, always replaced rather than added: a phase that arms a longer deadline must
    // not leave the earlier one to fire behind it, which `settle` alone cannot prevent.
    const armDeadline = (ms, fire) => {
      clearTimeout(timeout);
      timeout = setTimeout(fire, ms);
    };
    // A lookup that never resolves is the store's mutex parked, not a wedged owner, so a
    // resource read answers and keeps its socket instead of holding the connection for as
    // long as the mutex stays stuck. Nothing was forwarded, so the status says nothing
    // about the owner and the request never earns the 504 that means one.
    const expireLookup = () => {
      if (controller.signal.aborted) return;
      answerableDeadline = true;
      log("lookup-timeout");
      if (!res.headersSent && !res.destroyed) res.status(502).json({ error: "Hub unavailable" });
      stop();
    };
    res.once("close", stop);
    controller.signal.addEventListener(
      "abort",
      () => {
        // An answerable deadline must not take the socket down, or the 504 never
        // leaves the process. Node dumps the body we never read, so the
        // connection is not left occupied either.
        if (answerableDeadline) return;
        if (!req.complete) req.destroy();
        if (!res.destroyed) res.destroy();
      },
      { once: true },
    );
    const settle = () => {
      clearTimeout(timeout);
      res.removeListener("close", stop);
      close?.();
    };
    try {
      // The kind of deadline a stalled request gets depends only on the route, so it is decided
      // from the request itself. Route validation still runs after the lookup, so an ended
      // session keeps answering 404 ahead of 403/400 exactly as before.
      const resourceRead = req.method === "GET" && route.startsWith(`/resources/${target.resourceKey}/`);
      // A resource read is bounded from receipt as well: its lookup gets `lookupMs`, and the
      // phases after it replace that deadline rather than adding to it. A mutation keeps one
      // ceiling from receipt, so the lookup cannot push its own bound out.
      armDeadline(resourceRead ? bounds.lookupMs : bounds.actionMs, resourceRead ? expireLookup : stop);
      markServerDiagnostic(res, "lookup-start");
      let session;
      try {
        session = await store.findByKey(key);
      } finally {
        markServerDiagnostic(res, "lookup-end");
      }
      if (!session || session.status === "ended" || targets.get(key) !== target) {
        if (targets.get(key) === target) targets.delete(key);
        // A lookup deadline that already answered is complete on its own; writing over it would
        // throw, and the browser would lose the status it can still use.
        if (!res.destroyed && !res.headersSent) res.status(404).json({ error: "Hub unavailable" });
        return undefined;
      }
      if (controller.signal.aborted) return undefined;
      // The lookup is over. A resource read's next bound is the identity challenge's own, which
      // `authenticatedRequest` applies to that round trip alone, so nothing is armed here; charging
      // it to the lookup budget would let a slow identity answer be mistaken for a stalled store. A
      // mutation keeps the single ceiling it armed at receipt.
      if (resourceRead) clearTimeout(timeout);
      const cors = req.headers.origin === "null" ? { "Access-Control-Allow-Origin": "null", Vary: "Origin" } : {};
      res.set({
        ...cors,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      if (route === "/action" && !query && req.method === "OPTIONS") {
        const headers = String(req.headers["access-control-request-headers"] || "")
          .split(",")
          .map((v) => v.trim().toLowerCase())
          .filter(Boolean);
        if (
          req.headers.origin !== "null" ||
          req.headers["access-control-request-method"] !== "POST" ||
          headers.some((v) => !["content-type", "x-lavish-capability"].includes(v))
        )
          return res.status(403).end();
        return res
          .set({
            "Access-Control-Allow-Methods": "POST",
            "Access-Control-Allow-Headers": "content-type, x-lavish-capability",
          })
          .status(204)
          .end();
      }
      let action = false;
      if (route === "/action" && !query && req.method === "POST") {
        if (!equal(req.headers["x-lavish-capability"], target.capability))
          return res.status(403).json({ error: "Unauthorized" });
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || ""))
          return res.status(400).json({ error: "Invalid request" });
        action = true;
      } else if (req.method === "GET" && route.startsWith(`/resources/${target.resourceKey}/`)) {
        try {
          const segments = route.slice(`/resources/${target.resourceKey}/`.length).split("/").map(decodeURIComponent);
          if (segments.length < 2 || segments.some((v) => !v || v === "." || v === ".." || /[\\/\0]/.test(v)))
            throw new Error("Invalid path");
        } catch {
          return res.status(404).json({ error: "Not found" });
        }
        res.set("Content-Security-Policy", sandbox);
      } else return res.status(404).json({ error: "Not found" });
      // A mutation is already bounded from receipt, so a stalled upload cannot hold the request
      // open. A resource read replaces its lookup deadline once it forwards: the identity round
      // trip above is budgeted on its own.
      try {
        const chunks = [];
        let size = 0;
        if (action)
          for await (const chunk of req) {
            size += chunk.length;
            if (size > maxBody) return res.status(413).json({ error: "Request too large" });
            chunks.push(chunk);
          }
        const headers = action
          ? { "content-type": req.headers["content-type"], "x-lavish-capability": target.capability }
          : {};
        const result = await authenticatedRequest(
          target,
          action ? route : `${route}${query}`,
          req.method,
          headers,
          action ? Buffer.concat(chunks) : undefined,
          controller.signal,
          () => targets.get(key) === target,
          () => {
            log("forward");
            // The owner is now being asked. A resource read that does not start
            // answering within its own deadline is the wedged-owner case.
            if (!action) armDeadline(bounds.resourceMs, expireAnswerable);
          },
          bounds.identityMs,
        );
        log("upstream-response", result.response.statusCode);
        close = result.close;
        if (!action) {
          // Headers arrived, so the owner is answering. From here the ceiling
          // only guards a dead transfer, never a slow client.
          armDeadline(bounds.actionMs, stop);
        }
        const upstream = result.response;
        res.status(upstream.statusCode || 502);
        for (const name of ["content-type", "content-length"])
          if (upstream.headers[name]) res.set(name, upstream.headers[name]);
        await new Promise((resolve, reject) => {
          upstream.on("error", reject);
          res.on("error", reject);
          res.on("finish", () => {
            // Defensive: Node reports a truncated message as a stream error, so
            // this only covers a stream that ends cleanly while still incomplete.
            if (upstream.complete === false) reject(new Error("Hub response truncated"));
            else resolve();
          });
          res.on("close", () => {
            if (!res.writableFinished) reject(new Error("Client disconnected"));
          });
          if (res.destroyed || res.writableEnded) {
            upstream.destroy();
            reject(new Error("Client disconnected"));
            return;
          }
          upstream.pipe(res);
        });
      } catch (error) {
        // Only a resource read that never started answering can be told apart by
        // the browser, so it answers 504; everything else keeps 502 so a
        // mutation's observable outcome is unchanged.
        log(answerableDeadline ? "upstream-timeout" : "upstream-failure");
        if (!res.headersSent && !res.destroyed)
          res
            .status(error?.code === "HUB_TARGET_CHANGED" ? 404 : answerableDeadline ? 504 : 502)
            .json({ error: answerableDeadline ? "Hub timeout" : "Hub unavailable" });
        else if (!res.destroyed) res.destroy();
      }
    } finally {
      settle();
    }
  };
  return {
    control,
    dashboard: async (req, res) => {
      const hubs = [];
      for (const [key, target] of targets) {
        if (target.expires <= Date.now()) {
          targets.delete(key);
          continue;
        }
        if (!target.display) continue;
        const session = await store.findByKey(key);
        if (targets.get(key) !== target || target.expires <= Date.now()) continue;
        if (!session || session.status === "ended") {
          targets.delete(key);
          continue;
        }
        hubs.push({ ...target.display, url: `/session/${key}` });
      }
      res.set("Cache-Control", "no-store").json({ hubs });
    },
    register,
    unregister,
    generatedAssetRegistration: (key, name) => {
      const target = targets.get(key);
      return target && target.expires > Date.now() && target.assets.includes(name) ? target : null;
    },
    handle,
    clear: () => {
      targets.clear();
      for (const registration of pending) registration.ended = true;
    },
  };
}
