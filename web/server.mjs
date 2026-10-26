#!/usr/bin/env node
/**
 * ZX web — static files + CORS proxy for Stremio addons / Webtor.
 * TorrServer and MediaFlow Proxy are called from the browser (they live
 * on the user's LAN). This process only reaches public HTTP(S) hosts.
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const FETCH_TIMEOUT = 28_000;
const FETCH_TIMEOUT_MAX = 180_000;
const BODY_LIMIT = 4_000_000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Api-Key, X-Requested-With, Range"
  );
  res.setHeader("Access-Control-Expose-Headers", "X-ZX-Status, X-ZX-Error");
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function isPrivateHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h === "::1" || h === "0.0.0.0" || h.endsWith(".local")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10 || a === 127 || a === 0 || a === 255) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  return false;
}

function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw Object.assign(new Error("URL inválida"), { code: "bad_url" });
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw Object.assign(new Error("Sólo se permite http(s)"), { code: "bad_url" });
  }
  if (isPrivateHost(u.hostname)) {
    throw Object.assign(new Error("Host privado bloqueado (SSRF)"), { code: "ssrf" });
  }
  return u;
}

async function readBody(req, limit = BODY_LIMIT) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) {
      const err = new Error("payload too large");
      err.code = "too_large";
      throw err;
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function requestUrl(url, { method = "GET", headers = {}, body, timeout = FETCH_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    const u = typeof url === "string" ? new URL(url) : url;
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      u,
      {
        method,
        headers,
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        );
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(Object.assign(new Error("timeout"), { code: "timeout" }));
    });
    if (body) req.write(body);
    req.end();
  });
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // Los assets que faltan devuelven 404: si se respondiera index.html,
      // el navegador intentaría parsear HTML como fuente, script o imagen.
      if (path.extname(rel)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      const index = path.join(PUBLIC, "index.html");
      fs.readFile(index, (e2, buf) => {
        if (e2) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(buf);
      });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": ext === ".html" || ext === ".js" || ext === ".css" ? "no-store" : "public, max-age=86400",
    });
    fs.createReadStream(file).pipe(res);
  });
}

async function handleApiFetch(req, res, url) {
  let target;
  let method = "GET";
  let headers = {};
  let body;
  let timeout = FETCH_TIMEOUT;

  if (req.method === "GET" || req.method === "HEAD") {
    target = url.searchParams.get("url");
  } else {
    const raw = await readBody(req);
    let payload = {};
    try {
      payload = JSON.parse(raw.toString("utf8") || "{}");
    } catch {
      json(res, 400, { error: "JSON inválido" });
      return;
    }
    target = payload.url;
    method = String(payload.method || "GET").toUpperCase();
    headers = payload.headers && typeof payload.headers === "object" ? payload.headers : {};
    if (payload.timeout) {
      timeout = Math.min(FETCH_TIMEOUT_MAX, Math.max(1000, Number(payload.timeout) || FETCH_TIMEOUT));
    }
    if (payload.json !== undefined) {
      body = Buffer.from(JSON.stringify(payload.json));
      headers["content-type"] = headers["content-type"] || "application/json";
    } else if (payload.body != null) {
      body = Buffer.from(String(payload.body));
    }
  }

  if (!target) {
    json(res, 400, { error: "Falta url" });
    return;
  }

  let dest;
  try {
    dest = assertPublicUrl(target);
  } catch (err) {
    json(res, 400, { error: err.message, code: err.code || "bad_url" });
    return;
  }

  const outHeaders = {
    "user-agent":
      headers["user-agent"] ||
      headers["User-Agent"] ||
      "ZX/1.0 (Stremio addon client; +https://github.com/Stremio/stremio-addon-sdk)",
    accept: headers.accept || headers.Accept || "application/json, text/plain, */*",
  };
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (["host", "content-length", "connection", "cookie"].includes(key)) continue;
    outHeaders[key] = v;
  }

  try {
    const upstream = await requestUrl(dest, { method, headers: outHeaders, body, timeout });
    const ct = String(upstream.headers["content-type"] || "application/octet-stream");
    res.setHeader("X-ZX-Status", String(upstream.status));
    if (upstream.headers["retry-after"]) res.setHeader("X-ZX-Retry-After", String(upstream.headers["retry-after"]));
    res.writeHead(200, {
      "Content-Type": ct.includes("json") || ct.includes("text") ? "application/json; charset=utf-8" : ct,
      "Cache-Control": "no-store",
    });
    if (ct.includes("json") || ct.includes("text") || ct.includes("javascript")) {
      const text = upstream.body.toString("utf8");
      res.end(
        JSON.stringify({
          ok: upstream.status >= 200 && upstream.status < 400,
          status: upstream.status,
          url: dest.toString(),
          body: tryParse(text),
          raw: typeof tryParse(text) === "string" ? text.slice(0, 4000) : undefined,
          retryAfter: upstream.headers["retry-after"] || undefined,
        })
      );
      return;
    }
    res.end(
      JSON.stringify({
        ok: upstream.status >= 200 && upstream.status < 400,
        status: upstream.status,
        url: dest.toString(),
        body: null,
        raw: `(binario ${upstream.body.length} bytes)`,
      })
    );
  } catch (err) {
    json(res, 502, { error: err.message || "upstream", code: err.code || "upstream" });
  }
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (url.pathname === "/api/health") {
      json(res, 200, { ok: true, name: "zx-web", time: new Date().toISOString() });
      return;
    }
    if (url.pathname === "/api/fetch") {
      await handleApiFetch(req, res, url);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (err) {
    json(res, 500, { error: err.message || "internal" });
  }
}

export function createServer() {
  return http.createServer(handler);
}

// Sólo escuchamos cuando se ejecuta directamente (`npm run web`). Al importar
// el módulo desde los tests se puede elegir un puerto efímero (0).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, HOST, () => {
    console.log(`ZX web listening on http://${HOST}:${PORT}`);
  });
}
