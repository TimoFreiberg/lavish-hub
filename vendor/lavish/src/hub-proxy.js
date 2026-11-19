import crypto from "node:crypto";
import http from "node:http";
import { markServerDiagnostic } from "./server-diagnostics.js";

const secretPattern = /^[a-f0-9]{64}$/;
const sessionPattern = /^[a-f0-9]{16}$/;
const sandbox = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads";
const maxBody = 64 * 1024;

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

function upstreamRequest(agent, port, pathname, method, headers, body) {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = http.request({ host: "127.0.0.1", port, path: pathname, method, headers, agent }, resolve);
    } catch (error) {
      reject(error);
      return;
    }
    request.on("error", reject);
    request.end(body);
  });
}

async function authenticatedRequest(target, pathname, method, headers, body, signal, isCurrent, onForward) {
  const agent = new SingleSocketAgent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  const close = () => agent.destroy();
  signal.addEventListener("abort", close, { once: true });
  try {
    if (signal.aborted) throw new Error("Hub request cancelled");
    const challenge = crypto.randomBytes(32).toString("hex");
    const first = await upstreamRequest(agent, target.port, `/identity/${challenge}`, "GET", {}, undefined);
    let proof = "";
    for await (const chunk of first) {
      proof += chunk;
      if (proof.length > 1024) throw new Error("Invalid hub identity");
    }
    const expected = crypto.createHmac("sha256", target.identityKey).update(challenge).digest("hex");
    if (first.statusCode !== 200 || !equal(JSON.parse(proof).proof, expected)) throw new Error("Invalid hub identity");
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

export function createHubProxy({ store, events, jsonParser }) {
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
      (display !== undefined &&
        (!display ||
          typeof display.label !== "string" ||
          display.label.length > 255 ||
          !(display.summary === null || (typeof display.summary === "string" && display.summary.length <= 240))))
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
    current.display = display ? { label: display.label, summary: display.summary } : null;
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
    let log = () => {};
    if (process.env.LAVISH_HUB_DIAGNOSTICS === "1" && (req.method === "POST" || req.method === "OPTIONS")) {
      const id = ++diagnosticId,
        start = Date.now(),
        method = req.method;
      log = (event, status) => {
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
        } catch {}
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
    markServerDiagnostic(res, "lookup-start");
    const session = await store.findByKey(key);
    markServerDiagnostic(res, "lookup-end");
    if (!session || session.status === "ended" || targets.get(key) !== target) {
      if (targets.get(key) === target) targets.delete(key);
      return res.status(404).json({ error: "Hub unavailable" });
    }
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    controller.signal.addEventListener(
      "abort",
      () => {
        if (!req.complete) req.destroy();
        if (!res.destroyed) res.destroy();
      },
      { once: true },
    );
    const abort = () => controller.abort();
    res.once("close", abort);
    let close;
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
        () => log("forward"),
      );
      log("upstream-response", result.response.statusCode);
      close = result.close;
      const upstream = result.response;
      res.status(upstream.statusCode || 502);
      for (const name of ["content-type", "content-length"])
        if (upstream.headers[name]) res.set(name, upstream.headers[name]);
      await new Promise((resolve, reject) => {
        upstream.on("error", reject);
        res.on("error", reject);
        res.on("finish", resolve);
        res.on("close", () => {
          if (!res.writableFinished) reject(new Error("Client disconnected"));
        });
        upstream.pipe(res);
      });
    } catch (error) {
      log("upstream-failure");
      if (!res.headersSent && !res.destroyed)
        res.status(error?.code === "HUB_TARGET_CHANGED" ? 404 : 502).json({ error: "Hub unavailable" });
      else if (!res.destroyed) res.destroy();
    } finally {
      clearTimeout(timeout);
      res.removeListener("close", abort);
      close?.();
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
        hubs.push({ label: target.display.label, summary: target.display.summary, url: `/session/${key}` });
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
