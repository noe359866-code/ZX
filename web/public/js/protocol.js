import { addonBase, store } from "./store.js";

const UA = "ZX/1.0 (Stremio; Web)";

export async function fetchJson(url, { method = "GET", headers = {}, body, timeout = 22000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

export async function addonRequest(url) {
  try {
    const direct = await fetchJson(url, { headers: { accept: "application/json", "user-agent": UA } });
    if (direct.ok && direct.json) return direct.json;
  } catch {
    /* CORS or network — fall through to proxy */
  }
  const proxied = await fetchJson("/api/fetch?url=" + encodeURIComponent(url));
  if (!proxied.ok && proxied.status >= 500) {
    throw new Error(proxied.json?.error || "No se pudo contactar el addon");
  }
  const payload = proxied.json;
  if (payload && payload.body && typeof payload.body === "object") return payload.body;
  if (payload && payload.id && payload.resources) return payload;
  if (payload && (payload.metas || payload.meta || payload.streams || payload.subtitles)) return payload;
  throw new Error(payload?.error || "Respuesta de addon no válida");
}

export function extraPath(extra = {}) {
  const parts = Object.entries(extra)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return parts.length ? "/" + parts.join("/") : "";
}

export function catalogUrl(addon, type, id, extra) {
  return `${addonBase(addon.transportUrl)}/catalog/${type}/${id}${extraPath(extra)}.json`;
}

export function metaUrl(addon, type, id) {
  return `${addonBase(addon.transportUrl)}/meta/${type}/${encodeURIComponent(id)}.json`;
}

export function streamUrl(addon, type, id) {
  return `${addonBase(addon.transportUrl)}/stream/${type}/${encodeURIComponent(id)}.json`;
}

export function subtitlesUrl(addon, type, id) {
  return `${addonBase(addon.transportUrl)}/subtitles/${type}/${encodeURIComponent(id)}.json`;
}

export function resourceNames(manifest) {
  return (manifest?.resources || []).map((r) => (typeof r === "string" ? r : r.name));
}

export function resourceDef(manifest, name) {
  const r = (manifest?.resources || []).find((x) => (typeof x === "string" ? x : x.name) === name);
  if (!r) return null;
  if (typeof r === "string") {
    return { name: r, types: manifest.types || [], idPrefixes: manifest.idPrefixes || null };
  }
  return {
    name: r.name,
    types: r.types || manifest.types || [],
    idPrefixes: r.idPrefixes || manifest.idPrefixes || null,
  };
}

export function addonHandles(addon, resource, type, id) {
  const def = resourceDef(addon.manifest, resource);
  if (!def) return false;
  if (type && def.types?.length && !def.types.includes(type)) return false;
  if (id && def.idPrefixes?.length) {
    return def.idPrefixes.some((p) => String(id).startsWith(p));
  }
  return true;
}

export async function installAddon(transportUrl) {
  let url = transportUrl.trim();
  if (!url) throw new Error("Pega la URL del manifiesto");
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  if (!/manifest\.json(\?.*)?$/i.test(url)) {
    url = url.replace(/\/+$/, "") + "/manifest.json";
  }
  const manifest = await addonRequest(url);
  if (!manifest?.id || !manifest?.name) throw new Error("El manifiesto no es válido");
  store.upsertAddon({
    transportUrl: url.split("?")[0],
    manifest,
    enabled: true,
    installedAt: Date.now(),
  });
  return manifest;
}

export async function refreshManifests() {
  await Promise.all(
    store.addons().map(async (a) => {
      try {
        const manifest = await addonRequest(a.transportUrl);
        store.upsertAddon({ ...a, manifest });
      } catch (err) {
        a.error = err.message;
      }
    })
  );
}

export function enabledAddons() {
  return store.addons().filter((a) => a.enabled && a.manifest);
}

export async function loadCatalog(addon, catalog, extra = {}) {
  const data = await addonRequest(catalogUrl(addon, catalog.type, catalog.id, extra));
  return data?.metas || [];
}

export async function loadMeta(type, id) {
  const addons = enabledAddons().filter((a) => addonHandles(a, "meta", type, id));
  const results = await Promise.allSettled(addons.map((a) => addonRequest(metaUrl(a, type, id))));
  let best = null;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value?.meta) {
      const meta = r.value.meta;
      if (!best || (meta.videos?.length || 0) > (best.videos?.length || 0) || (meta.description && !best.description)) {
        best = { ...best, ...meta };
      }
    }
  }
  return best;
}

export async function loadStreams(type, id) {
  const addons = enabledAddons().filter((a) => addonHandles(a, "stream", type, id));
  const rows = await Promise.allSettled(
    addons.map(async (a) => {
      const data = await addonRequest(streamUrl(a, type, id));
      return (data?.streams || []).map((s) => ({
        ...s,
        _addon: a.manifest?.name || a.transportUrl,
        _addonId: a.manifest?.id,
      }));
    })
  );
  const streams = [];
  for (const r of rows) {
    if (r.status === "fulfilled") streams.push(...r.value);
  }
  return streams;
}

export async function loadSubtitles(type, id) {
  const addons = enabledAddons().filter((a) => addonHandles(a, "subtitles", type, id));
  const rows = await Promise.allSettled(
    addons.map(async (a) => {
      const data = await addonRequest(subtitlesUrl(a, type, id));
      return data?.subtitles || [];
    })
  );
  const out = [];
  for (const r of rows) if (r.status === "fulfilled") out.push(...r.value);
  return out;
}

export async function searchAll(query) {
  const q = query.trim();
  if (!q) return [];
  const jobs = [];
  for (const addon of enabledAddons()) {
    for (const cat of addon.manifest?.catalogs || []) {
      const extra = cat.extra || [];
      const supports = extra.some((e) => e.name === "search") || (cat.extraSupported || []).includes("search");
      if (!supports) continue;
      jobs.push(
        loadCatalog(addon, cat, { search: q })
          .then((metas) => metas.map((m) => ({ ...m, _addon: addon.manifest.name })))
          .catch(() => [])
      );
    }
  }
  const lists = await Promise.all(jobs);
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const m of list) {
      const key = `${m.type}:${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
  }
  return out;
}

export function boardCatalogs() {
  const rows = [];
  for (const addon of enabledAddons()) {
    for (const cat of addon.manifest?.catalogs || []) {
      const extra = cat.extra || [];
      const required = extra.filter((e) => e.isRequired).map((e) => e.name);
      if (required.length && required.some((n) => n !== "genre")) continue;
      if ((cat.extraRequired || []).length) continue;
      rows.push({ addon, catalog: cat });
    }
  }
  return rows;
}
