const traces = new WeakMap();
const methods = new Set(["GET", "HEAD", "POST", "OPTIONS", "PUT", "PATCH", "DELETE"]);
const events = new Set(["lookup-start", "lookup-end"]);

function routeClass(url) {
  const pathname = (url || "").split("?", 1)[0];
  if (/^\/hub-proxy\/[^/]+\/action$/.test(pathname)) return "proxy-action";
  if (/^\/hub-proxy(?:\/|$)/.test(pathname)) return "proxy-resource";
  if (/^\/artifact\/[^/]+\/?$/.test(pathname) || /^\/artifact\/[^/]+\/.*\.html?$/i.test(pathname))
    return "artifact-page";
  if (/^\/artifact\//.test(pathname)) return "artifact-asset";
  return "other";
}

export function markServerDiagnostic(res, event) {
  if (events.has(event)) traces.get(res)?.(event);
}

export function createServerDiagnostics({ enabled, write = writeDiagnostic }) {
  if (!enabled) return (_req, _res, next) => next();
  let nextId = 0;
  return (req, res, next) => {
    const id = ++nextId;
    const start = Date.now();
    const method = methods.has(req.method) ? req.method : "OTHER";
    const route = routeClass(req.url);
    const emit = (event, status) => {
      try {
        write(
          JSON.stringify({
            diagnostic: "hub",
            side: "server",
            id,
            method,
            route,
            event,
            time: new Date().toISOString(),
            elapsedMs: Date.now() - start,
            ...(status === undefined ? {} : { status }),
          }),
        );
      } catch {}
    };
    traces.set(res, emit);
    emit("arrive");
    res.once("finish", () => emit("finish", res.statusCode));
    res.once("close", () => {
      emit("close", res.headersSent ? res.statusCode : undefined);
      traces.delete(res);
    });
    next();
  };
}

function writeDiagnostic(line) {
  if (!process.stderr.writableNeedDrain && process.stderr.writable) process.stderr.write(`${line}\n`);
}
