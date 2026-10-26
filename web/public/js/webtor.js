import { store } from "./store.js";
import { fetchJson } from "./protocol.js";

export const WEBTOR_REST = "https://api.webtor.io/v1";

const ERROR_ES = {
  unauthorized: "API key inválida o ausente. Emítela en webtor.io/profile.",
  forbidden: "Esta clave no tiene permiso (scope) para esa operación.",
  payment_required: "Webtor API es de plan de pago. La cuenta gratuita responde 402.",
  not_found: "Recurso no encontrado en Webtor.",
  bad_request: "Petición rechazada por Webtor.",
  rate_limited: "Demasiadas peticiones. Espera y reintenta.",
  upstream_error: "Fallo interno de Webtor. Reintenta.",
  upstream_timeout: "Webtor tardó demasiado resolviendo el magnet.",
  unavailable: "Webtor no está disponible ahora.",
  authorization_pending: "Esperando que confirmes el código en webtor.io…",
  slow_down: "El sondeo va demasiado rápido.",
  expired_token: "El código expiró. Genera uno nuevo.",
};

function restBase(settings = store.settings()) {
  return String(settings.webtorRest || WEBTOR_REST).replace(/\/+$/, "");
}

function authHeaders(settings = store.settings(), extra = {}) {
  const headers = { accept: "application/json", ...extra };
  if (settings.webtorKey) {
    headers.Authorization = "Bearer " + settings.webtorKey;
    headers["X-Api-Key"] = settings.webtorKey;
  }
  return headers;
}

function errorFrom(body, status) {
  const err = body?.error;
  const code = err?.code || (status === 401 ? "unauthorized" : status === 402 ? "payment_required" : "");
  const msg = ERROR_ES[code] || err?.message || (status ? `Webtor HTTP ${status}` : "Error de Webtor");
  const e = new Error(msg);
  e.code = code || "webtor";
  e.status = status;
  return e;
}

export async function webtorCall(path, { method = "GET", json, body, headers = {}, timeout = 25000, auth = true } = {}) {
  const settings = store.settings();
  const url = path.startsWith("http") ? path : restBase(settings) + path;
  const payload = {
    url,
    method,
    headers: auth ? authHeaders(settings, headers) : { accept: "application/json", ...headers },
    timeout,
  };
  if (json !== undefined) payload.json = json;
  else if (body != null) payload.body = body;

  const proxied = await fetchJson("/api/fetch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    timeout: timeout + 4000,
  });
  const wrap = proxied.json || {};
  const status = wrap.status ?? proxied.status;
  const data = wrap.body;
  if (status === 429) {
    const err = errorFrom(data, status);
    err.retryAfter = Number(wrap.retryAfter || 3);
    throw err;
  }
  if (!(status >= 200 && status < 300)) throw errorFrom(data, status);
  return data;
}

export async function pingWebtor(settings = store.settings()) {
  if (!restBase(settings)) return { ok: false, detail: "Sin URL REST" };
  if (!settings.webtorKey) {
    return { ok: false, detail: "Falta API key (Bearer). Plan de pago · webtor.io/profile" };
  }
  try {
    const profile = await webtorCall("/profile");
    const tier = profile?.tier?.name || "cuenta";
    const email = profile?.email ? ` · ${profile.email}` : "";
    return { ok: true, detail: `${tier}${email}`, profile };
  } catch (err) {
    return { ok: false, detail: err.message, code: err.code };
  }
}

export async function addResource(magnet) {
  return webtorCall("/resource", {
    method: "POST",
    body: magnet,
    headers: { "content-type": "text/plain" },
    timeout: 180000,
  });
}

export async function getResource(id) {
  return webtorCall(`/resource/${encodeURIComponent(id)}`);
}

export async function listFiles(id) {
  const items = [];
  let offset = 0;
  const limit = 200;
  for (let page = 0; page < 20; page++) {
    const listed = await webtorCall(
      `/resource/${encodeURIComponent(id)}/list?output=list&limit=${limit}&offset=${offset}&sort=size`
    );
    const batch = listed?.items || [];
    items.push(...batch);
    const total = listed?.items_count;
    offset += batch.length;
    if (!batch.length || (total != null && offset >= total) || batch.length < limit) break;
  }
  return items;
}

function pickExportUrl(exported) {
  const map = exported?.exports || {};
  const stream = map.stream || map.hls || map.Stream;
  const download = map.download || map.Download;
  const tag = stream?.html_tag;
  const sources = tag?.sources || [];
  const hls = sources.find((s) => /mpegurl|hls|m3u8/i.test(s.type || s.src || ""));
  const url =
    hls?.src ||
    tag?.src ||
    sources[0]?.src ||
    stream?.url ||
    download?.url;
  const tracks = (tag?.tracks || []).map((t) => ({
    url: t.src,
    lang: t.srclang || t.label,
    id: t.label,
  }));
  const kind = url && /\.m3u8(\?|$)/i.test(url) ? "hls" : "http";
  return { url, kind, tracks, poster: tag?.poster };
}

export async function exportFile(resourceId, contentId, { imdbId } = {}) {
  const q = new URLSearchParams({ types: "stream,download,subtitles" });
  if (imdbId) q.set("imdb-id", imdbId);
  return webtorCall(`/resource/${encodeURIComponent(resourceId)}/export/${encodeURIComponent(contentId)}?${q}`);
}

function isVideoItem(it) {
  if (!it || it.type === "dir" || it.type === "directory") return false;
  if (it.media_format && /video|audio/i.test(String(it.media_format))) return true;
  if (it.mime_type && /^(video|audio)\//i.test(it.mime_type)) return true;
  return /\.(mkv|mp4|m4v|avi|mov|wmv|flv|webm|ts|m2ts|mpg|mpeg|vob)$/i.test(it.name || it.path || "");
}

function pickFile(items, fileIdx) {
  const files = items.filter(isVideoItem);
  const pool = files.length ? files : items.filter((x) => x.type !== "dir" && x.type !== "directory");
  if (!pool.length) return null;
  if (fileIdx != null) {
    const byIndex = pool.find((f) => f.index === fileIdx) || items.find((f) => f.index === fileIdx);
    if (byIndex) return byIndex;
    if (pool[fileIdx]) return pool[fileIdx];
  }
  return [...pool].sort((a, b) => (b.size || 0) - (a.size || 0))[0];
}

export async function playViaWebtor(stream, meta) {
  const magnet = stream._magnet;
  if (!magnet) throw new Error("El stream no tiene infoHash/magnet");
  const resource = await addResource(magnet);
  const id = resource.id || resource.ID || resource.resource_id || stream.infoHash;
  if (!id) throw new Error("Webtor no devolvió un resource id");

  let file = resource.file || resource.File;
  if (!file?.id && resource.files_count !== 1) {
    const items = await listFiles(id);
    file = pickFile(items, stream.fileIdx);
  }
  if (!file) throw new Error("Webtor no listó archivos de vídeo");

  const contentId = file.id || String(file.index ?? stream.fileIdx ?? 0);
  const imdb = String(meta?.id || "").match(/tt\d+/)?.[0];
  const exported = await exportFile(id, contentId, { imdbId: imdb });
  const picked = pickExportUrl(exported);
  if (!picked.url) throw new Error("Webtor no devolvió URL de stream (exports.stream)");

  if (store.settings().webtorSaveLibrary) {
    webtorCall("/library", { method: "POST", json: { resource_id: id } }).catch(() => {});
  }

  return {
    playUrl: picked.url,
    engine: "Webtor",
    kind: picked.kind,
    resourceId: id,
    subtitles: picked.tracks,
    poster: picked.poster || meta?.poster,
  };
}

export async function listLibrary({ type = "all", limit = 40 } = {}) {
  return webtorCall(`/library?type=${encodeURIComponent(type)}&sort=recent&limit=${limit}`);
}

export async function startDeviceAuth() {
  return webtorCall("/device/code", {
    method: "POST",
    json: { name: "ZX Web" },
    auth: false,
  });
}

export async function pollDeviceToken(deviceCode) {
  try {
    const data = await webtorCall("/device/token", {
      method: "POST",
      json: { device_code: deviceCode },
      auth: false,
    });
    return { ok: true, key: data.key || data.access_token || data.token };
  } catch (err) {
    if (err.code === "authorization_pending" || err.code === "slow_down") {
      return { ok: false, pending: true, slow: err.code === "slow_down", message: err.message };
    }
    throw err;
  }
}
