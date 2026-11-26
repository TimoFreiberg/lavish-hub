import crypto from "node:crypto";
import * as zlib from "node:zlib";

/** @param {string} header */
function artifactEncoding(header) {
  const qualities = new Map();
  for (const part of (header || "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    let quality = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/.exec(param);
      if (!match) {
        quality = 0;
        break;
      }
      quality = Number(match[1]);
    }
    qualities.set(name, quality);
  }
  const wildcard = qualities.get("*");
  const quality = (name) => qualities.get(name) ?? (name === "identity" ? (wildcard === 0 ? 0 : 1) : (wildcard ?? 0));
  const candidates = [...(typeof zlib.zstdCompress === "function" ? ["zstd"] : []), "gzip", "identity"];
  candidates.sort((a, b) => quality(b) - quality(a));
  return { encoding: quality(candidates[0]) > 0 ? candidates[0] : null, identityAllowed: quality("identity") > 0 };
}

function compressArtifactBytes(encoding, bytes) {
  return new Promise((resolve, reject) => {
    const compress = encoding === "zstd" ? zlib.zstdCompress : zlib.gzip;
    compress(bytes, (error, result) => (error ? reject(error) : resolve(result)));
  });
}

function hubAssetIdentity(stats) {
  if (
    !stats.isFile() ||
    ![stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].every((value) => typeof value === "bigint") ||
    stats.dev === 0n ||
    stats.ino === 0n ||
    stats.mtimeNs <= 0n ||
    stats.ctimeNs <= 0n
  ) return null;
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}

/** @param {{hubProxy: any, compress?: any, hooks?: any, isShuttingDown: () => boolean}} options */
export function createHubAssets({ hubProxy, compress = compressArtifactBytes, hooks = {}, isShuttingDown }) {
  const verifiedHubAssets = new Map();
  let verifiedHubAssetBytes = 0;
  const maxVerifiedHubAssetBytes = 64 * 1024 * 1024;
  const compressedHubAssets = new Map();
  const compressingHubAssets = new Map();
  const hubCompressionQueue = [];
  let activeHubCompressions = 0;
  let compressedHubAssetBytes = 0;
  const maxCompressedHubAssetBytes = 8 * 1024 * 1024;

  async function cachedHubCompression(cacheKey, encoding, bytes, res) {
    if (isShuttingDown() || res.destroyed) throw Object.assign(new Error("Compression cancelled"), { status: 503 });
    if (compressedHubAssets.has(cacheKey)) {
      const cached = compressedHubAssets.get(cacheKey);
      compressedHubAssets.delete(cacheKey);
      compressedHubAssets.set(cacheKey, cached);
      return cached;
    }
    let job = compressingHubAssets.get(cacheKey);
    if (job) {
      hooks.onHubCompressionJoin?.();
    } else {
      if (compressingHubAssets.size >= 12)
        throw Object.assign(new Error("Hub compression capacity exceeded"), { status: 503 });
      job = { consumers: 0, queued: false, reject: null, pending: null };
      const current = job;
      const pending = (async () => {
        if (activeHubCompressions >= 6) {
          await new Promise((resolve, reject) => {
            current.queued = true;
            current.reject = reject;
            hubCompressionQueue.push({ job: current, resolve });
            hooks.onHubCompressionQueued?.();
          });
        } else {
          activeHubCompressions++;
        }
        try {
          const result = await compress(encoding, bytes);
          if (result.length <= maxCompressedHubAssetBytes && !isShuttingDown()) {
            while (compressedHubAssets.size >= 24 || compressedHubAssetBytes + result.length > maxCompressedHubAssetBytes) {
              const oldest = compressedHubAssets.keys().next().value;
              compressedHubAssetBytes -= compressedHubAssets.get(oldest).length;
              compressedHubAssets.delete(oldest);
            }
            compressedHubAssets.set(cacheKey, result);
            compressedHubAssetBytes += result.length;
          }
          return result;
        } finally {
          const next = hubCompressionQueue.shift();
          if (next) {
            next.job.queued = false;
            next.resolve();
          } else activeHubCompressions--;
        }
      })();
      current.pending = pending.finally(() => {
        if (compressingHubAssets.get(cacheKey) === current) compressingHubAssets.delete(cacheKey);
      });
      compressingHubAssets.set(cacheKey, current);
    }
    job.consumers++;
    const current = job;
    const disconnect = () => {
      current.consumers--;
      if (current.consumers === 0 && current.queued) {
        const index = hubCompressionQueue.findIndex((entry) => entry.job === current);
        if (index !== -1) hubCompressionQueue.splice(index, 1);
        current.queued = false;
        if (compressingHubAssets.get(cacheKey) === current) compressingHubAssets.delete(cacheKey);
        current.reject(Object.assign(new Error("Compression cancelled"), { status: 503 }));
        hooks.onHubCompressionCancel?.();
      }
    };
    res.once("close", disconnect);
    try {
      return await current.pending;
    } finally {
      res.removeListener("close", disconnect);
    }
  }

  async function prepareHtml(req, res, html) {
    res.vary("Accept-Encoding");
    res.setHeader("cache-control", "no-store");
    const choice = artifactEncoding(req.get("Accept-Encoding"));
    if (!choice.encoding) return null;
    let encoding = choice.encoding;
    let bytes = Buffer.from(html);
    if (encoding !== "identity") {
      try {
        bytes = await compress(encoding, bytes);
      } catch (error) {
        if (!choice.identityAllowed) throw error;
        encoding = "identity";
      }
    }
    return { encoding, bytes };
  }

  function sendHtml(res, representation) {
    if (!representation) {
      res.status(406).send("Not acceptable");
      return;
    }
    if (representation.encoding !== "identity") res.setHeader("content-encoding", representation.encoding);
    res.type("html").send(representation.bytes);
  }

  async function serveRegistered(req, res, { key, assetPath, file, opened, stats, etagEnabled }) {
    const registration = hubProxy.generatedAssetRegistration(key, assetPath);
    if (!registration) return { handled: false, etag: undefined };
    let identity = null;
    try {
      identity = hubAssetIdentity(await opened.handle.stat({ bigint: true }));
    } catch {
      // Filesystems without usable high-resolution metadata always reverify the bytes.
    }
    const cacheKey = `${file}:${assetPath}`;
    const cached = identity && verifiedHubAssets.get(cacheKey);
    let bytes;
    let hash;
    if (cached && cached.identity === identity) {
      ({ bytes, hash } = cached);
      verifiedHubAssets.delete(cacheKey);
      verifiedHubAssets.set(cacheKey, cached);
    } else {
      bytes = await opened.handle.readFile();
      hash = crypto.createHash("sha256").update(bytes).digest("hex");
      let after = null;
      try {
        after = hubAssetIdentity(await opened.handle.stat({ bigint: true }));
      } catch {
        // Do not cache when the post-read metadata is unavailable.
      }
      if (identity && identity === after && assetPath === `hub-asset-${hash}.js` && bytes.length <= maxVerifiedHubAssetBytes) {
        const previous = verifiedHubAssets.get(cacheKey);
        if (previous) verifiedHubAssetBytes -= previous.bytes.length;
        verifiedHubAssets.delete(cacheKey);
        while (verifiedHubAssets.size >= 24 || verifiedHubAssetBytes + bytes.length > maxVerifiedHubAssetBytes) {
          const oldest = verifiedHubAssets.keys().next().value;
          verifiedHubAssetBytes -= verifiedHubAssets.get(oldest).bytes.length;
          verifiedHubAssets.delete(oldest);
        }
        verifiedHubAssets.set(cacheKey, { identity, bytes, hash });
        verifiedHubAssetBytes += bytes.length;
      }
    }
    if (assetPath !== `hub-asset-${hash}.js` || hubProxy.generatedAssetRegistration(key, assetPath) !== registration)
      return { handled: false, etag: undefined };
    const choice = artifactEncoding(req.get("Accept-Encoding"));
    const etag = `W/"${hash}"`;
    res.vary("Accept-Encoding");
    // Every variant varies on Origin, but only verified full responses grant opaque-origin access.
    res.vary("Origin");
    const grantBundleCors = () => {
      if (req.headers.origin === "null") res.setHeader("access-control-allow-origin", "null");
    };
    if (req.get("range") && choice.identityAllowed) return { handled: false, etag };
    res.setHeader("cache-control", "public, max-age=0");
    if (!choice.encoding) {
      res.status(406).send("Not acceptable");
      return { handled: true, etag };
    }
    res.type("js");
    res.setHeader("last-modified", stats.mtime.toUTCString());
    if (etagEnabled) res.setHeader("etag", etag);
    const match = req.get("if-match");
    const unmodified = Date.parse(req.get("if-unmodified-since") || "");
    if (match ? !res.getHeader("etag") || match !== "*" : Number.isFinite(unmodified) && Date.parse(stats.mtime.toUTCString()) > unmodified)
      throw Object.assign(new Error("Precondition Failed"), { status: 412 });
    if (req.fresh) {
      grantBundleCors();
      res.status(304).end();
      return { handled: true, etag };
    }
    let encoding = choice.encoding;
    let representation = bytes;
    if (encoding !== "identity") {
      try {
        representation = await cachedHubCompression(`${hash}:${encoding}`, encoding, bytes, res);
      } catch (error) {
        if (!choice.identityAllowed) throw error;
        encoding = "identity";
      }
    }
    if (hubProxy.generatedAssetRegistration(key, assetPath) !== registration) {
      res.status(404).send("Not found");
      return { handled: true, etag };
    }
    grantBundleCors();
    if (encoding !== "identity") res.setHeader("content-encoding", encoding);
    res.setHeader("content-length", String(representation.length));
    res.send(representation);
    return { handled: true, etag };
  }

  function shutdown() {
    for (const { job } of hubCompressionQueue.splice(0)) {
      job.queued = false;
      job.reject(Object.assign(new Error("Server shutting down"), { status: 503 }));
    }
  }

  return { negotiate: artifactEncoding, prepareHtml, sendHtml, serveRegistered, shutdown };
}
