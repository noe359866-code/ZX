import { store } from "./store.js";
import { playViaWebtor as webtorPlay, pingWebtor } from "./webtor.js";

export { pingWebtor };

const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|mov|wmv|flv|webm|ts|m2ts|mpg|mpeg|vob)$/i;

export function streamKind(stream) {
  if (stream?.ytId) return "youtube";
  if (stream?.infoHash || isMagnet(stream?.url)) return "torrent";
  const url = stream?.url || "";
  if (/\.m3u8(\?|$)/i.test(url) || stream?.type === "hls") return "hls";
  if (/\.mpd(\?|$)/i.test(url) || stream?.type === "dash") return "dash";
  if (stream?.externalUrl && !stream?.url) return "external";
  if (url) return "http";
  return "unknown";
}

export function isMagnet(url) {
  return typeof url === "string" && url.toLowerCase().startsWith("magnet:");
}

export function magnetFromStream(stream) {
  if (isMagnet(stream.url)) return stream.url;
  if (!stream.infoHash) return null;
  const parts = [`magnet:?xt=urn:btih:${stream.infoHash}`];
  if (stream.name || stream.title) parts.push("dn=" + encodeURIComponent(stream.name || stream.title));
  for (const src of stream.sources || []) {
    const s = String(src);
    if (s.startsWith("tracker:")) parts.push("tr=" + encodeURIComponent(s.slice(8)));
    else if (s.startsWith("http") || s.startsWith("udp:")) parts.push("tr=" + encodeURIComponent(s));
  }
  return parts.join("&");
}

export function headersFromStream(stream) {
  const hints = stream?.behaviorHints || {};
  return {
    ...(hints.proxyHeaders?.request || {}),
    ...(hints.requestHeaders || {}),
  };
}

function withAuth(headers, user, pass) {
  if (!user) return headers;
  const token = btoa(`${user}:${pass || ""}`);
  return { ...headers, Authorization: `Basic ${token}` };
}

export async function pingTorrServer(settings = store.settings()) {
  const base = (settings.torrserverUrl || "").replace(/\/+$/, "");
  if (!base) return { ok: false, detail: "Sin URL" };
  try {
    const res = await fetch(base + "/echo", {
      headers: withAuth({}, settings.torrserverUser, settings.torrserverPass),
    });
    const text = await res.text();
    return { ok: res.ok, detail: text.slice(0, 80) || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

export async function pingMediaFlow(settings = store.settings()) {
  const base = (settings.mediaflowUrl || "").replace(/\/+$/, "");
  if (!base) return { ok: false, detail: "Sin URL" };
  try {
    const u = new URL(base + "/proxy/ip");
    if (settings.mediaflowPassword) u.searchParams.set("api_password", settings.mediaflowPassword);
    const res = await fetch(u);
    const text = await res.text();
    return { ok: res.ok, detail: text.slice(0, 120) || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}



export function mediaflowUrl(destination, { headers = {}, kind = "http" } = {}, settings = store.settings()) {
  const base = (settings.mediaflowUrl || "").replace(/\/+$/, "");
  if (!base) return null;
  const path =
    kind === "hls"
      ? "/proxy/hls/manifest.m3u8"
      : kind === "dash"
        ? "/proxy/mpd/manifest.m3u8"
        : "/proxy/stream";
  const u = new URL(base + path);
  u.searchParams.set("d", destination);
  if (settings.mediaflowPassword) u.searchParams.set("api_password", settings.mediaflowPassword);
  for (const [k, v] of Object.entries(headers)) {
    if (v) u.searchParams.set("h_" + k, v);
  }
  return u.toString();
}

async function torrentsPost(settings, payload) {
  const base = (settings.torrserverUrl || "").replace(/\/+$/, "");
  const res = await fetch(base + "/torrents", {
    method: "POST",
    headers: withAuth({ "Content-Type": "application/json" }, settings.torrserverUser, settings.torrserverPass),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) throw new Error(json?.error || text.slice(0, 180) || `TorrServer HTTP ${res.status}`);
  return json;
}

function pickVideoFile(files, fileIdx) {
  if (!Array.isArray(files) || !files.length) return null;
  if (fileIdx != null && files[fileIdx]) return { file: files[fileIdx], index: fileIdx };
  const scored = files
    .map((f, i) => ({ f, i, name: f.path || f.name || "" }))
    .filter((x) => VIDEO_EXT.test(x.name));
  const pool = scored.length ? scored : files.map((f, i) => ({ f, i, name: f.path || f.name || "" }));
  pool.sort((a, b) => (b.f.length || b.f.size || 0) - (a.f.length || a.f.size || 0));
  return { file: pool[0].f, index: pool[0].i };
}

export async function playViaTorrServer(stream, meta, settings = store.settings()) {
  const magnet = magnetFromStream(stream);
  if (!magnet) throw new Error("El stream no tiene infoHash/magnet");
  const added = await torrentsPost(settings, {
    action: "add",
    link: magnet,
    title: meta?.name || stream.name || stream.title || "",
    poster: meta?.poster || "",
    save_to_db: false,
  });
  const hash = added?.hash || stream.infoHash;
  let torrent = added;
  for (let i = 0; i < 30; i++) {
    const files = torrent?.file_stats || torrent?.files || torrent?.FileStats;
    if (files?.length) break;
    await sleep(1000);
    torrent = await torrentsPost(settings, { action: "get", hash });
  }
  const files = torrent?.file_stats || torrent?.files || torrent?.FileStats || [];
  const picked = pickVideoFile(files, stream.fileIdx);
  if (!picked) throw new Error("TorrServer no devolvió archivos de vídeo");
  const name = picked.file.path || picked.file.name || "video.mkv";
  const base = (settings.torrserverUrl || "").replace(/\/+$/, "");
  const url = `${base}/stream/${encodeURIComponent(name)}?link=${encodeURIComponent(hash)}&index=${picked.index}&play`;
  return { playUrl: url, engine: "TorrServer", kind: "http", hash, file: name };
}

export async function playViaWebtor(stream, meta) {
  const magnet = magnetFromStream(stream);
  if (!magnet) throw new Error("El stream no tiene infoHash/magnet");
  return webtorPlay({ ...stream, _magnet: magnet }, meta);
}

export async function resolveStream(stream, meta) {
  const settings = store.settings();
  const kind = streamKind(stream);
  if (kind === "external") {
    return { playUrl: stream.externalUrl, engine: "external", kind: "external" };
  }
  if (kind === "youtube") {
    return { playUrl: "https://www.youtube.com/embed/" + stream.ytId + "?autoplay=1", engine: "YouTube", kind: "youtube" };
  }
  if (kind === "torrent") {
    const engine = settings.torrentEngine || "auto";
    const errors = [];
    const tryTs = engine === "torrserver" || engine === "auto";
    const tryWt = engine === "webtor" || engine === "auto";
    if (tryTs && settings.torrserverUrl) {
      try {
        return await playViaTorrServer(stream, meta, settings);
      } catch (err) {
        errors.push("TorrServer: " + err.message);
        if (engine === "torrserver") throw err;
      }
    }
    if (tryWt && settings.webtorKey) {
      try {
        return await playViaWebtor(stream, meta);
      } catch (err) {
        errors.push("Webtor: " + err.message);
        if (engine === "webtor") throw err;
      }
    }
    throw new Error(
      errors.join(" · ") || "Configura TorrServer o una API key de Webtor (plan de pago) para reproducir torrents"
    );
  }

  if (!stream.url) throw new Error("El stream no tiene URL");
  const headers = headersFromStream(stream);
  // `notWebReady: false` es una declaración explícita del addon (o de la
  // muestra local) de que el HLS se puede pedir desde el navegador: no lo
  // enviemos a MediaFlow aunque el usuario tenga activado preferProxyHls.
  const webReady = stream.behaviorHints?.notWebReady === false;
  const needsProxy =
    settings.mediaflowEnabled &&
    settings.mediaflowUrl &&
    (Object.keys(headers).length > 0 ||
      (!webReady &&
        (stream.behaviorHints?.notWebReady || (settings.preferProxyHls && (kind === "hls" || kind === "dash")))));
  if (needsProxy) {
    const playUrl = mediaflowUrl(stream.url, { headers, kind }, settings);
    return { playUrl, engine: "MediaFlow Proxy", kind: kind === "dash" ? "hls" : kind, headers };
  }
  return { playUrl: stream.url, engine: "directo", kind, headers };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
