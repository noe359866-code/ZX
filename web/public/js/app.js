import { store, yearOf, AVATARS, MAX_PROFILES, avatarStyle } from "./store.js";
import {
  installAddon,
  refreshManifests,
  boardCatalogs,
  loadCatalog,
  loadMeta,
  loadStreams,
  loadSubtitles,
  searchAll,
  enabledAddons,
} from "./protocol.js";
import { resolveStream, pingTorrServer, pingMediaFlow, pingWebtor, streamKind } from "./engines.js";
import { startDeviceAuth, pollDeviceToken, listLibrary as webtorLibrary } from "./webtor.js";
import { ZXPlayer } from "./player.js";
import { DEMO_ROWS, DEMO_MOVIES, DEMO_SERIES, demoMeta, demoSearch, demoStreams, isDemoId } from "./demo.js";

const $ = (s, r = document) => r.querySelector(s);
const view = $("#view");
const player = new ZXPlayer($("#player-root"));

// Cada navegación invalida los renderizados asíncronos anteriores. Así una
// respuesta tardía de un addon no pisa la pantalla que el usuario ya abrió.
let renderToken = 0;

function bootDone() {
  const boot = $("#boot");
  if (!boot) return;
  boot.classList.add("off");
  setTimeout(() => boot.remove(), 300);
}

function statusStrip(state, detail = "") {
  const copy = {
    loading: ["Conectando con tus addons…", "Mientras tanto ves el catálogo de muestra local."],
    offline: ["Sin conexión con los addons", detail || "Cinemeta y los addons instalados no respondieron. La interfaz sigue funcionando con el catálogo de muestra."],
    online: ["Catálogos cargados", detail || "Contenido real de tus addons."],
  }[state];
  return `<div class="demo-strip ${state === "online" ? "online" : ""}" id="status-strip" role="status">
    <span class="dot"></span>
    <span><strong>${esc(copy[0])}</strong> · ${esc(copy[1])}</span>
    <span class="spacer"></span>
    <button class="btn btn-ghost" data-retry>Reintentar</button>
    <button class="btn btn-ghost" data-go="addons">Configurar addons</button>
  </div>`;
}

function setStatus(state, detail) {
  const strip = $("#status-strip");
  if (!strip) return;
  const holder = document.createElement("div");
  holder.innerHTML = statusStrip(state, detail);
  strip.replaceWith(holder.firstElementChild);
}

function demoRow(row) {
  return `<section class="section">
    <div class="section-head"><h2>${esc(row.title)}</h2></div>
    <div class="scroller">${row.metas.map(card).join("")}</div>
  </section>`;
}

function toast(msg, err = false) {
  const el = document.createElement("div");
  el.className = "toast" + (err ? " err" : "");
  el.textContent = msg;
  $("#toast-root").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function svgPlay() {
  return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
}
function svgPlus() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>`;
}
function svgSearch() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3-3"/></svg>`;
}

function posterEl(meta) {
  if (meta?.poster) return `<img src="${esc(meta.poster)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  const letter = (meta?.name || "?").slice(0, 1).toUpperCase();
  return `<div class="ph">${letter}</div>`;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function card(meta) {
  const y = yearOf(meta);
  const kind = meta.type === "series" ? "Serie" : meta.type === "movie" ? "Película" : meta.type;
  return `<button class="card" data-open="${esc(meta.type)}:${esc(meta.id)}">
    <div class="poster">${posterEl(meta)}${meta.imdbRating ? `<span class="badge">★ ${esc(meta.imdbRating)}</span>` : ""}
      ${meta._demo ? `<span class="demo-tag">Muestra local</span>` : ""}
      <div class="play-hit"><span>${svgPlay()}</span></div>
    </div>
    <div class="card-title">${esc(meta.name)}</div>
    <div class="card-sub">${esc([y, kind].filter(Boolean).join("  ·  "))}</div>
  </button>`;
}

function route() {
  renderToken += 1;
  bootDone();
  const hash = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = hash.split("?");
  const q = new URLSearchParams(qs || "");
  const parts = path.split("/").filter(Boolean);
  const current = parts[0] || "/";
  const dtype = q.get("type") || "movie";
  document.querySelectorAll(".nav-link").forEach((b) => {
    const goTo = b.dataset.go || "";
    let on = false;
    if (goTo === "/" && current === "/") on = true;
    else if (goTo.startsWith("discover") && current === "discover") on = goTo.includes("type=" + dtype);
    else if (goTo.split("?")[0] === current) on = true;
    b.classList.toggle("active", on);
  });
  view.scrollTop = 0;
  $("#mast")?.classList.toggle("solid", current !== "/");
  if (!parts.length) return renderHome();
  if (parts[0] === "discover") return renderDiscover(q.get("type") || "movie");
  if (parts[0] === "search") return renderSearch(q.get("q") || "");
  if (parts[0] === "detail") return renderDetail(parts[1], decodeURIComponent(parts.slice(2).join("/")));
  if (parts[0] === "addons") return renderAddons();
  if (parts[0] === "settings") return renderSettings();
  if (parts[0] === "library") return renderLibrary();
  return renderHome();
}

function go(hash) {
  location.hash = hash;
}

async function renderHome() {
  const token = renderToken;
  const cw = store.profile()?.continueWatching || [];
  const cwHtml = cw.length
    ? `<section class="section"><div class="section-head"><h2>Seguir viendo</h2></div><div class="scroller">${cw.map(card).join("")}</div></section>`
    : "";

  // 1) Primer pintado inmediato y 100 % local: héroe, filas y estado. Nunca
  //    dejamos una pantalla negra esperando a Cinemeta o a un proxy CORS.
  const demoBoard = `
    ${statusStrip("loading")}
    <section class="hero" id="hero">${heroMarkup(DEMO_MOVIES[0])}</section>
    <div id="cw">${cwHtml}</div>
    <div id="rows">
      <div class="page" style="padding-top:0;padding-bottom:0">
        <div class="demo-steps">
          <div class="step"><b>01 · Catálogo</b><span>Cinemeta trae películas y series de fábrica. Pega el manifest.json de cualquier addon en <strong>Addons</strong>.</span></div>
          <div class="step"><b>02 · Motores</b><span>HLS directo o MediaFlow Proxy, torrents con TorrServer y Webtor. Se configuran en <strong>Motores</strong>.</span></div>
          <div class="step"><b>03 · Reproductor</b><span>ZX Player usa hls.js servido desde este mismo servidor: sin CDN, sin scripts de terceros.</span></div>
        </div>
      </div>
      ${DEMO_ROWS.map(demoRow).join("")}
    </div>`;
  view.innerHTML = demoBoard;
  view._featured = DEMO_MOVIES[0];

  // 2) Detrás, los addons reales. Si responden, sustituyen el tablero entero.
  const rows = boardCatalogs().slice(0, 8);
  if (!rows.length) {
    setStatus("offline", "No hay addons con catálogos activos. Activa Cinemeta o instala uno nuevo.");
    return;
  }
  const loaded = await Promise.all(
    rows.map(async (row) => {
      try {
        const metas = await loadCatalog(row.addon, row.catalog, {});
        return { ...row, metas: Array.isArray(metas) ? metas : [] };
      } catch {
        return { ...row, metas: [] };
      }
    })
  );
  if (token !== renderToken) return;
  const good = loaded.filter((r) => r.metas.length);
  if (!good.length) {
    setStatus("offline");
    return;
  }
  const featured = good[0].metas[0];
  let full = featured;
  try {
    full = (await loadMeta(featured.type, featured.id)) || featured;
  } catch {
    /* la ficha del catálogo ya sirve */
  }
  if (token !== renderToken) return;
  view._featured = full;
  view.innerHTML = `
    ${statusStrip("online", `${good.length} catálogos · ${enabledAddons().length} addons activos`)}
    <section class="hero" id="hero">${heroMarkup(full)}</section>
    <div id="cw">${cwHtml}</div>
    <div id="rows">${good
      .map(
        (r) => `<section class="section">
          <div class="section-head"><h2>${esc(rowTitle(r))}</h2></div>
          <div class="scroller">${r.metas.map(card).join("")}</div>
        </section>`
      )
      .join("")}</div>`;
}

function heroMarkup(meta) {
  const bg = meta.background || meta.poster || "";
  const kind = meta.type === "series" ? "Serie" : "Película";
  return `
    <div class="hero-bg" style="background-image:url('${esc(bg)}')"></div>
    <div class="hero-body">
      <div class="included">${meta._demo ? "Muestra local · ZX" : "Incluido con ZX"}</div>
      <h1>${esc(meta.name || "ZX")}</h1>
      <div class="meta-line">
        ${meta.imdbRating ? `<span>★ ${esc(meta.imdbRating)}</span>` : ""}
        ${yearOf(meta) ? `<span>${esc(yearOf(meta))}</span>` : ""}
        ${meta.runtime ? `<span>${esc(meta.runtime)}</span>` : ""}
        <span class="pill hd">${esc(kind)}</span>
        ${meta._demo ? `<span class="pill hd">Demo</span>` : `<span class="pill hd">4K</span>`}
        ${(meta.genres || []).slice(0, 2).map((g) => `<span>${esc(g)}</span>`).join("")}
      </div>
      <p>${esc((meta.description || "").slice(0, 220))}</p>
      <div class="row-actions">
        ${meta.id ? `<button class="btn btn-primary" data-open="${esc(meta.type)}:${esc(meta.id)}">${svgPlay()} Reproducir</button>` : `<button class="btn btn-primary" data-go="addons">Instalar addons</button>`}
        ${meta.id ? `<button class="btn btn-ghost" data-open="${esc(meta.type)}:${esc(meta.id)}">Más información</button>` : ""}
        ${meta.id ? `<button class="btn btn-ghost" data-lib="${esc(meta.id)}">${svgPlus()} Mi lista</button>` : ""}
      </div>
    </div>`;
}

function rowTitle(r) {
  const n = r.catalog.name || r.catalog.id;
  const t = r.catalog.type === "series" ? "series" : "películas";
  if (/popular/i.test(n)) return r.catalog.type === "series" ? "Series populares" : "Películas populares";
  if (/destac/i.test(n) || /imdb/i.test(n) || /feature/i.test(n)) return r.catalog.type === "series" ? "Series destacadas" : "Tendencias";
  return `${n} · ${t}`;
}

async function renderDiscover(type) {
  const token = renderToken;
  const title = type === "series" ? "Series" : type === "movie" ? "Películas" : "Explorar";
  const sample = type === "series" ? DEMO_SERIES : type === "movie" ? DEMO_MOVIES : [];
  const chips = `<div class="chips" style="margin:0 0 18px;justify-content:flex-start">
    ${[
      ["movie", "Películas"],
      ["series", "Series"],
      ["tv", "TV"],
      ["channel", "Canales"],
    ].map(([t, label]) => `<button class="chip ${t === type ? "on" : ""}" data-go="discover?type=${t}">${label}</button>`).join("")}
  </div>`;
  view.innerHTML = `<div class="page"><h1>${title}</h1>${chips}
    <div id="disc">${statusStrip("loading")}
      ${sample.length ? `<div class="grid">${sample.map(card).join("")}</div>` : `<div class="empty">Este tipo depende de tus addons.</div>`}
    </div>
  </div>`;
  const rows = boardCatalogs().filter((r) => r.catalog.type === type);
  const lists = await Promise.all(
    rows.slice(0, 4).map((r) => loadCatalog(r.addon, r.catalog, {}).catch(() => []))
  );
  if (token !== renderToken) return;
  const seen = new Set();
  const metas = [];
  for (const list of lists) {
    for (const m of list || []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      metas.push(m);
    }
  }
  if (!metas.length) {
    setStatus("offline", sample.length ? "Mostrando la muestra local mientras no respondan los addons." : "Sin catálogos de este tipo.");
    return;
  }
  $("#disc").innerHTML = `${statusStrip("online", `${metas.length} títulos`)}<div class="grid">${metas.map(card).join("")}</div>`;
}

async function renderSearch(q) {
  const token = renderToken;
  $("#q").value = q;
  const sample = demoSearch(q);
  view.innerHTML = `<div class="page"><h1>Buscar</h1><p class="lead">${q ? "Resultados para «" + esc(q) + "»" : "Escribe en la barra superior. Se consulta el extra search de todos los addons."}</p>
    <div id="res">${q ? `${statusStrip("loading")}<div class="grid">${sample.map(card).join("")}</div>` : ""}</div></div>`;
  if (!q) return;
  try {
    const metas = await searchAll(q);
    if (token !== renderToken) return;
    if (metas.length) {
      $("#res").innerHTML = `${statusStrip("online", `${metas.length} resultados`)}<div class="grid">${metas.map(card).join("")}</div>`;
    } else {
      setStatus("offline", "Ningún addon respondió; abajo tienes la muestra local.");
      if (!sample.length) $("#res").insertAdjacentHTML("beforeend", `<div class="empty">Sin resultados.</div>`);
    }
  } catch (err) {
    if (token !== renderToken) return;
    setStatus("offline", err.message || "No se pudo buscar en los addons.");
  }
}

async function renderDetail(type, id) {
  const token = renderToken;
  const local = isDemoId(id) ? demoMeta(id) : null;
  if (!local) view.innerHTML = `<div class="page"><div class="skel" style="height:360px;border-radius:24px"></div></div>`;
  let meta = local;
  if (!local) {
    try {
      meta = await loadMeta(type, id);
    } catch (err) {
      view.innerHTML = `<div class="page"><div class="empty">${esc(err.message)}</div></div>`;
      return;
    }
    if (token !== renderToken) return;
    if (!meta) meta = { id, type, name: id };
  }
  paintDetail(meta, type, id);
}

function paintDetail(meta, type, id) {
  const videos = meta.videos || [];
  const seasons = [...new Set(videos.map((v) => v.season).filter((s) => s != null))].sort((a, b) => a - b);
  const inLib = store.inLibrary(meta.id);
  view.innerHTML = `
    <div class="detail">
      <div class="detail-bg" style="background-image:url('${esc(meta.background || meta.poster || "")}')"></div>
      <div class="detail-wrap">
        <div class="detail-poster">${posterEl(meta)}</div>
        <div>
          <div class="included">${meta._demo ? "Muestra local · ZX" : "Incluido con ZX"}</div>
          <h1>${esc(meta.name)}</h1>
          <div class="meta-line">${yearOf(meta) ? `<span>${esc(yearOf(meta))}</span>` : ""}${meta.runtime ? `<span>${esc(meta.runtime)}</span>` : ""}${(meta.genres || []).map((g) => `<span>${esc(g)}</span>`).join("")}</div>
          <p class="desc">${esc(meta.description || "Sin sinopsis.")}</p>
          ${meta.cast?.length ? `<p class="cast">Reparto: ${esc(meta.cast.slice(0, 8).join(", "))}</p>` : ""}
          <div class="row-actions">
            <button class="btn btn-primary" data-play-meta="${esc(type)}:${esc(id)}">${svgPlay()} Reproducir</button>
            <button class="btn btn-ghost" data-lib-full="1">${inLib ? "En mi lista" : "Añadir a mi lista"}</button>
          </div>
          ${seasons.length ? `<div class="seasons">${seasons.map((s, i) => `<button data-season="${s}" class="${i === 0 ? "on" : ""}">T${s}</button>`).join("")}</div><div class="episodes" id="eps"></div>` : `<div class="streams" id="streams"><div class="empty">Buscando streams…</div></div>`}
        </div>
      </div>
    </div>`;
  view._meta = meta;
  if (seasons.length) {
    const paint = (season) => {
      const eps = videos.filter((v) => v.season === season).sort((a, b) => (a.episode || 0) - (b.episode || 0));
      $("#eps").innerHTML = eps
        .map(
          (v) => `<button class="ep" data-play-video="${esc(v.id)}">
            <strong>E${v.episode ?? "?"} · ${esc(v.title || v.name || "Episodio")}</strong>
            <span>${esc((v.overview || "").slice(0, 90))}</span>
          </button>`
        )
        .join("");
    };
    paint(seasons[0]);
    view.querySelectorAll("[data-season]").forEach((b) =>
      b.addEventListener("click", () => {
        view.querySelectorAll("[data-season]").forEach((x) => x.classList.toggle("on", x === b));
        paint(Number(b.dataset.season));
      })
    );
  } else {
    fillStreams(type, id, meta);
  }
  $("[data-lib-full]")?.addEventListener("click", () => {
    store.toggleLibrary(meta);
    toast(store.inLibrary(meta.id) ? "Añadido a tu lista" : "Quitado de tu lista");
    renderDetail(type, id);
  });
}

async function fillStreams(type, id, meta) {
  const box = $("#streams");
  if (!box) return;
  const token = renderToken;
  try {
    const streams = isDemoId(id) ? demoStreams(id) : await loadStreams(type, id);
    if (token !== renderToken || !box.isConnected) return;
    if (!streams.length) {
      box.innerHTML = `<div class="empty">Ningún addon devolvió streams. Instala uno de streams (Torrentio, MediaFusion, tu Worker Vimeus, etc.).</div>`;
      return;
    }
    box.innerHTML = streams
      .map((s, i) => {
        const kind = streamKind(s);
        const title = s.name || s.title || s.description || "Stream";
        const desc = [s._addon, s.description || s.title, kind].filter(Boolean).join(" · ");
        return `<button class="stream" data-stream="${i}">
          <div><b>${esc(title)}</b><small>${esc(desc)}</small></div>
          <span class="engine-tag">${esc(kind)}</span>
        </button>`;
      })
      .join("");
    box._streams = streams;
    box._meta = meta;
    box._videoId = id;
    box._type = type;
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

async function playVideo(type, videoId, meta, stream) {
  try {
    toast("Resolviendo stream…");
    let chosen = stream;
    if (!chosen) {
      const streams = await loadStreams(type, videoId);
      if (!streams.length) throw new Error("Sin streams para este título");
      chosen = streams[0];
      if (streams.length > 1) {
        const box = $("#streams");
        if (box) {
          await fillStreams(type, videoId, meta);
          return;
        }
      }
    }
    const resolved = await resolveStream(chosen, meta);
    const addonSubs = await loadSubtitles(type, videoId).catch(() => []);
    const subs = [...(resolved.subtitles || []), ...addonSubs];
    store.pushContinue({
      id: meta?.id || videoId,
      videoId,
      type: meta?.type || type,
      name: meta?.name || chosen.name,
      poster: meta?.poster,
      imdbRating: meta?.imdbRating,
    });
    await player.open({
      ...resolved,
      title: meta?.name || chosen.name,
      subtitle: chosen.name || chosen.title,
      poster: meta?.poster,
      headers: resolved.headers,
      subtitles: subs,
    });
  } catch (err) {
    toast(err.message, true);
  }
}

async function renderLibrary() {
  const items = store.profile()?.library || [];
  const pname = store.profile()?.name || "este perfil";
  view.innerHTML = `<div class="page"><h1>Mi lista</h1>
    <p class="lead">${items.length ? items.length + " títulos en el perfil " + esc(pname) + "." : "Aún no hay nada en el perfil " + esc(pname) + ". Añádelo desde una ficha."}</p>
    <div class="grid">${items.map(card).join("")}</div>
    <div class="section-head" style="margin-top:28px"><h2>Biblioteca Webtor</h2><span>GET /library</span></div>
    <div id="wt-lib" class="empty">Cargando…</div>
  </div>`;
  const box = $("#wt-lib");
  if (!store.settings().webtorKey) {
    box.innerHTML = `Configura una API key en Motores para ver tu biblioteca de webtor.io.`;
    return;
  }
  try {
    const data = await webtorLibrary({ limit: 40 });
    const rows = data?.items || [];
    if (!rows.length) {
      box.innerHTML = `La biblioteca Webtor está vacía. Activa «guardar en /library» al reproducir.`;
      return;
    }
    box.className = "addon-list";
    box.innerHTML = rows
      .map(
        (it) => `<article class="addon">
          <div class="logo-ph"></div>
          <div>
            <h3>${esc(it.name || it.resource_id)}</h3>
            <p>${esc(it.resource_id)} · ${it.files_count || "?"} archivos</p>
          </div>
        </article>`
      )
      .join("");
  } catch (err) {
    box.innerHTML = esc(err.message);
  }
}

function renderAddons() {
  store.persist();
  const list = store.addons();
  view.innerHTML = `<div class="page">
    <h1>Addons de Stremio</h1>
    <p class="lead"><strong>Cinemeta ya viene instalado</strong> (catálogos y fichas). Añade aquí los addons de streams pegando su <code>manifest.json</code>.</p>
    <div class="install">
      <input id="addon-url" placeholder="https://tu-addon.example/manifest.json" />
      <button class="btn btn-primary" id="addon-add">Instalar</button>
    </div>
    <div class="addon-list">
      ${list
        .map((a) => {
          const m = a.manifest || {};
          const res = (m.resources || []).map((r) => (typeof r === "string" ? r : r.name));
          const locked = a.locked || a.official;
          return `<article class="addon">
            ${m.logo ? `<img src="${esc(m.logo)}" alt="" referrerpolicy="no-referrer">` : `<div class="logo-ph"></div>`}
            <div>
              <h3>${esc(m.name || a.transportUrl)} ${locked ? `<span class="tag">incluido</span>` : ""}</h3>
              <p>${esc(m.description || a.transportUrl)}</p>
              <div class="tags">${res.map((r) => `<span class="tag">${esc(r)}</span>`).join("")}${(m.types || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
            </div>
            <div>
              <div class="switch"><span>${locked ? "De fábrica" : a.enabled ? "Activo" : "Off"}</span>
                ${locked ? "" : `<button class="toggle ${a.enabled ? "on" : ""}" data-toggle="${esc(a.transportUrl)}"></button>`}
              </div>
              ${locked ? "" : `<button class="btn btn-danger" data-del="${esc(a.transportUrl)}">Quitar</button>`}
            </div>
          </article>`;
        })
        .join("")}
    </div>
  </div>`;
  $("#addon-add").onclick = async () => {
    const url = $("#addon-url").value;
    try {
      const m = await installAddon(url);
      toast("Instalado: " + m.name);
      renderAddons();
    } catch (err) {
      toast(err.message, true);
    }
  };
}

function renderSettings() {
  const s = store.settings();
  view.innerHTML = `<div class="page">
    <h1>Motores</h1>
    <p class="lead">La API oficial de Webtor es <code>https://api.webtor.io/v1</code> (Bearer). El host <code>*.api.cosmic-crab.buzz</code> es el cluster de <em>export</em>: ahí aterrizan las URLs firmadas y de corta vida, no el REST.</p>
    <div class="engine-grid">
      <div class="engine"><h3>MediaFlow Proxy</h3><p>HLS, DASH y HTTP con Referer/Origin.</p><div class="status" id="st-mf"><i></i> —</div></div>
      <div class="engine"><h3>TorrServer</h3><p>BitTorrent → HTTP Range para el player.</p><div class="status" id="st-ts"><i></i> —</div></div>
      <div class="engine"><h3>Webtor v1</h3><p>POST /resource → GET /list → GET /export</p><div class="status" id="st-wt"><i></i> —</div></div>
    </div>
    <form class="panel" id="cfg">
      <div class="form-grid">
        <div class="form-row"><label>MediaFlow URL</label><input name="mediaflowUrl" value="${esc(s.mediaflowUrl)}" placeholder="http://127.0.0.1:8888"></div>
        <div class="form-row"><label>MediaFlow API password</label><input name="mediaflowPassword" value="${esc(s.mediaflowPassword)}" type="password" autocomplete="off"></div>
        <div class="form-row"><label>TorrServer URL</label><input name="torrserverUrl" value="${esc(s.torrserverUrl)}" placeholder="http://127.0.0.1:8090"></div>
        <div class="form-row"><label>TorrServer usuario / clave</label>
          <div style="display:flex;gap:8px">
            <input name="torrserverUser" value="${esc(s.torrserverUser)}" placeholder="usuario">
            <input name="torrserverPass" value="${esc(s.torrserverPass)}" type="password" placeholder="clave">
          </div>
        </div>
        <div class="form-row"><label>Webtor REST</label><input name="webtorRest" value="${esc(s.webtorRest)}" placeholder="https://api.webtor.io/v1"></div>
        <div class="form-row"><label>Webtor API key (Bearer)</label><input name="webtorKey" value="${esc(s.webtorKey)}" type="password" autocomplete="off" placeholder="desde webtor.io/profile"></div>
        <div class="form-row"><label>Motor torrent</label>
          <select name="torrentEngine">
            <option value="auto" ${s.torrentEngine === "auto" ? "selected" : ""}>Auto (TorrServer → Webtor)</option>
            <option value="torrserver" ${s.torrentEngine === "torrserver" ? "selected" : ""}>Sólo TorrServer</option>
            <option value="webtor" ${s.torrentEngine === "webtor" ? "selected" : ""}>Sólo Webtor</option>
          </select>
        </div>
      </div>
      <div class="switch"><span>Usar MediaFlow para HLS/DASH y streams con cabeceras</span>
        <button type="button" class="toggle ${s.mediaflowEnabled ? "on" : ""}" id="mf-en"></button>
      </div>
      <div class="switch"><span>Pasar playlists HLS por MediaFlow aunque no pidan cabeceras</span>
        <button type="button" class="toggle ${s.preferProxyHls ? "on" : ""}" id="mf-hls"></button>
      </div>
      <div class="switch"><span>Al reproducir con Webtor, guardar también en POST /library</span>
        <button type="button" class="toggle ${s.webtorSaveLibrary ? "on" : ""}" id="wt-lib"></button>
      </div>
      <div class="row-actions">
        <button class="btn btn-primary" type="submit">Guardar</button>
        <button class="btn btn-ghost" type="button" id="ping">Probar conexiones</button>
        <button class="btn btn-ghost" type="button" id="wt-device">Vincular con webtor.io</button>
      </div>
      <div id="device-box" hidden class="device-box"></div>
    </form>
  </div>`;
  $("#mf-en").onclick = () => $("#mf-en").classList.toggle("on");
  $("#mf-hls").onclick = () => $("#mf-hls").classList.toggle("on");
  $("#wt-lib").onclick = () => $("#wt-lib").classList.toggle("on");
  $("#cfg").onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    store.setSettings({
      mediaflowUrl: fd.get("mediaflowUrl"),
      mediaflowPassword: fd.get("mediaflowPassword"),
      torrserverUrl: fd.get("torrserverUrl"),
      torrserverUser: fd.get("torrserverUser"),
      torrserverPass: fd.get("torrserverPass"),
      webtorRest: fd.get("webtorRest"),
      webtorKey: fd.get("webtorKey"),
      torrentEngine: fd.get("torrentEngine"),
      mediaflowEnabled: $("#mf-en").classList.contains("on"),
      preferProxyHls: $("#mf-hls").classList.contains("on"),
      webtorSaveLibrary: $("#wt-lib").classList.contains("on"),
    });
    toast("Ajustes guardados");
    pingAll();
  };
  $("#ping").onclick = () => pingAll();
  $("#wt-device").onclick = () => startWebtorDevice();
  pingAll();
}

let deviceTimer = 0;
async function startWebtorDevice() {
  const box = $("#device-box");
  if (!box) return;
  box.hidden = false;
  box.innerHTML = `<p class="lead">Pidiendo código de dispositivo…</p>`;
  try {
    const auth = await startDeviceAuth();
    const code = auth.user_code;
    const uri = auth.verification_uri_complete || auth.verification_uri || "https://webtor.io";
    const interval = Math.max(3, Number(auth.interval) || 5);
    box.innerHTML = `<p>Abre <a href="${esc(uri)}" target="_blank" rel="noopener">${esc(uri)}</a> e introduce:</p>
      <div class="device-code">${esc(code)}</div>
      <p class="lead">Esperando confirmación (POST /device/token)…</p>`;
    clearInterval(deviceTimer);
    const tick = async () => {
      try {
        const r = await pollDeviceToken(auth.device_code);
        if (r.ok && r.key) {
          clearInterval(deviceTimer);
          store.setSettings({ webtorKey: r.key });
          const input = document.querySelector("input[name=webtorKey]");
          if (input) input.value = r.key;
          box.innerHTML = `<p>Clave guardada. Plan de pago requerido para streams.</p>`;
          toast("Webtor vinculado");
          pingAll();
          return;
        }
        if (r.slow) return;
      } catch (err) {
        clearInterval(deviceTimer);
        box.innerHTML = `<p>${esc(err.message)}</p>`;
      }
    };
    deviceTimer = setInterval(tick, interval * 1000);
    tick();
  } catch (err) {
    box.innerHTML = `<p>${esc(err.message)}</p>`;
  }
}

async function pingAll() {
  const paint = (id, r) => {
    const el = $(id);
    if (!el) return;
    el.className = "status " + (r.ok ? "ok" : "bad");
    el.innerHTML = `<i></i> ${esc(r.detail)}`;
  };
  paint("#st-mf", await pingMediaFlow());
  paint("#st-ts", await pingTorrServer());
  paint("#st-wt", await pingWebtor());
}

function syncChrome() {
  const p = store.profile();
  const face = $("#who-face");
  if (!face) return;
  if (!p) {
    face.textContent = "+";
    face.style.background = "#1a242f";
    return;
  }
  face.textContent = (p.name || "?").slice(0, 1).toUpperCase();
  face.style.background = avatarStyle(p.avatar);
}

let gateMode = "pick";
let editingId = null;

function openGate(mode = "pick") {
  gateMode = mode;
  editingId = null;
  $("#gate")?.classList.remove("hidden");
  renderGate();
}

function closeGate() {
  $("#gate")?.classList.add("hidden");
}

function renderGate() {
  const box = $("#gate");
  if (!box) return;
  if (gateMode === "form") {
    renderGateForm(box);
    return;
  }
  const manage = gateMode === "manage";
  const list = store.profiles();
  box.innerHTML = `
    <h1>${manage ? "Administrar perfiles" : "¿Quién está viendo?"}</h1>
    <p class="sub">${manage ? "Toca un perfil para editarlo." : "Cada perfil tiene su lista y su continuar viendo."}</p>
    <div class="profiles">
      ${list
        .map(
          (p) => `<button class="p-card ${p.kids ? "kids" : ""} ${manage ? "edit" : ""}" data-profile="${esc(p.id)}">
            <div class="p-face" style="background:${avatarStyle(p.avatar)}">${esc((p.name || "?").slice(0, 1).toUpperCase())}
              ${p.kids ? `<span class="p-kids">KIDS</span>` : ""}
            </div>
            <div class="p-name">${esc(p.name)}</div>
          </button>`
        )
        .join("")}
      ${
        list.length < MAX_PROFILES
          ? `<button class="p-card p-add" data-profile-add>
              <div class="p-face">+</div>
              <div class="p-name">Añadir perfil</div>
            </button>`
          : ""
      }
    </div>
    <div class="gate-actions">
      ${!manage ? `<button class="btn btn-primary" data-gate-start>Entrar</button>` : ""}
      <button class="btn btn-ghost" data-gate-manage>${manage ? "Listo" : "Administrar perfiles"}</button>
      ${store.state.activeProfileId ? `<button class="btn btn-ghost" data-gate-close>Cerrar</button>` : ""}
      <button class="btn btn-ghost" data-go="settings" data-gate-close>Motores y cuenta</button>
    </div>`;
}

function renderGateForm(box) {
  const p = editingId ? store.profiles().find((x) => x.id === editingId) : { name: "", avatar: AVATARS[0].id, kids: false };
  box.innerHTML = `
    <h1>${editingId ? "Editar perfil" : "Nuevo perfil"}</h1>
    <p class="sub">Nombre, color y, si quieres, un perfil Kids.</p>
    <form class="gate-sheet" id="p-form">
      <div class="form-row"><label>Nombre</label><input name="name" value="${esc(p.name || "")}" maxlength="18" required placeholder="Nombre"></div>
      <label>Avatar</label>
      <div class="avatar-pick">
        ${AVATARS.map((a) => `<button type="button" data-av="${a.id}" class="${a.id === p.avatar ? "on" : ""}" style="background:${a.bg}"></button>`).join("")}
      </div>
      <input type="hidden" name="avatar" value="${esc(p.avatar)}">
      <div class="switch"><span>Perfil Kids</span><button type="button" class="toggle ${p.kids ? "on" : ""}" id="p-kids"></button></div>
      <div class="row-actions">
        <button class="btn btn-primary" type="submit">Guardar</button>
        <button class="btn btn-ghost" type="button" data-gate-back>Cancelar</button>
        ${editingId && store.profiles().length > 1 ? `<button class="btn btn-danger" type="button" data-profile-del="${esc(editingId)}">Eliminar</button>` : ""}
      </div>
    </form>`;
  $("#p-kids")?.addEventListener("click", () => $("#p-kids").classList.toggle("on"));
  box.querySelectorAll("[data-av]").forEach((b) =>
    b.addEventListener("click", () => {
      box.querySelectorAll("[data-av]").forEach((x) => x.classList.toggle("on", x === b));
      box.querySelector("input[name=avatar]").value = b.dataset.av;
    })
  );
  $("#p-form").onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      name: fd.get("name"),
      avatar: fd.get("avatar"),
      kids: $("#p-kids")?.classList.contains("on"),
    };
    try {
      if (editingId) store.updateProfile(editingId, payload);
      else store.addProfile(payload);
      gateMode = "manage";
      editingId = null;
      renderGate();
      syncChrome();
    } catch (err) {
      toast(err.message, true);
    }
  };
}

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-gate-close]")) closeGate();
  if (e.target.closest("[data-gate-start]")) {
    const first = store.profiles()[0];
    if (first) store.selectProfile(first.id);
    closeGate();
    syncChrome();
    route();
    return;
  }
  if (e.target.closest("[data-retry]")) {
    setStatus("loading");
    toast("Reconectando con los addons…");
    refreshManifests()
      .catch(() => {})
      .finally(() => route());
    return;
  }
  const manageBtn = e.target.closest("[data-gate-manage]");
  if (manageBtn) {
    gateMode = gateMode === "manage" ? "pick" : "manage";
    renderGate();
    return;
  }
  if (e.target.closest("[data-gate-back]")) {
    gateMode = "manage";
    editingId = null;
    renderGate();
    return;
  }
  if (e.target.closest("[data-profile-add]")) {
    editingId = null;
    gateMode = "form";
    renderGate();
    return;
  }
  const delP = e.target.closest("[data-profile-del]");
  if (delP) {
    try {
      store.removeProfile(delP.dataset.profileDel);
      gateMode = "manage";
      editingId = null;
      renderGate();
      syncChrome();
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }
  const pick = e.target.closest("[data-profile]");
  if (pick) {
    if (gateMode === "manage") {
      editingId = pick.dataset.profile;
      gateMode = "form";
      renderGate();
    } else {
      store.selectProfile(pick.dataset.profile);
      closeGate();
      syncChrome();
      route();
    }
    return;
  }
  const goBtn = e.target.closest("[data-go]");
  if (goBtn) {
    e.preventDefault();
    const target = goBtn.dataset.go;
    go(target.startsWith("/") ? target : "/" + target);
    return;
  }
  const open = e.target.closest("[data-open]");
  if (open) {
    const [type, ...rest] = open.dataset.open.split(":");
    go(`/detail/${type}/${rest.join(":")}`);
    return;
  }
  const tog = e.target.closest("[data-toggle]");
  if (tog) {
    const url = tog.dataset.toggle;
    const a = store.addons().find((x) => x.transportUrl === url);
    store.toggleAddon(url, !(a && a.enabled));
    renderAddons();
    return;
  }
  const del = e.target.closest("[data-del]");
  if (del) {
    store.removeAddon(del.dataset.del);
    renderAddons();
    return;
  }
  const libBtn = e.target.closest("[data-lib]");
  if (libBtn) {
    const meta = view._featured || view._meta;
    if (meta) {
      store.toggleLibrary(meta);
      toast(store.inLibrary(meta.id) ? "Añadido a tu lista" : "Quitado de tu lista");
    }
    return;
  }
  const playMeta = e.target.closest("[data-play-meta]");
  if (playMeta) {
    const [type, ...rest] = playMeta.dataset.playMeta.split(":");
    const id = rest.join(":");
    const meta = view._meta;
    const firstVideo = meta?.videos?.find((v) => v.id && v.id !== meta.id) || meta?.videos?.[0];
    const targetId = firstVideo?.id || id;
    const streamsBox = $("#streams");
    if (streamsBox) fillStreams(type, targetId, meta);
    else fillOrPlay(type, targetId, meta);
    return;
  }
  const playVid = e.target.closest("[data-play-video]");
  if (playVid) {
    const meta = view._meta;
    fillOrPlay(meta?.type || "series", playVid.dataset.playVideo, meta);
    return;
  }
  const st = e.target.closest("[data-stream]");
  if (st) {
    const box = st.closest(".streams");
    const stream = box._streams[Number(st.dataset.stream)];
    playVideo(box._type, box._videoId, box._meta, stream);
  }
});

async function fillOrPlay(type, id, meta) {
  const wrap = view.querySelector(".detail-wrap > div:last-child");
  if (!wrap.querySelector("#streams")) {
    const box = document.createElement("div");
    box.className = "streams";
    box.id = "streams";
    wrap.appendChild(box);
  }
  await fillStreams(type, id, meta);
}

$("#q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    store.state.lastSearch = e.target.value;
    store.persist();
    go("/search?q=" + encodeURIComponent(e.target.value.trim()));
  }
});

view.addEventListener("scroll", () => {
  const path = (location.hash.replace(/^#/, "") || "/").split("?")[0];
  const home = path === "/" || path === "";
  $("#mast")?.classList.toggle("solid", view.scrollTop > 40 || !home);
});

window.addEventListener("hashchange", route);

$("#who")?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  openGate("pick");
});

// Arranque: la interfaz se pinta ANTES de cualquier petición de red. Si sólo
// hay un perfil se entra directo (la puerta de perfiles sigue en el avatar).
store.persist();
if (!store.state.activeProfileId && store.profiles().length === 1) {
  store.selectProfile(store.profiles()[0].id);
}
syncChrome();
route();
if (!store.state.activeProfileId) openGate("pick");

// Los manifiestos se actualizan en segundo plano: nunca bloquean el render.
refreshManifests()
  .catch(() => {})
  .finally(() => {
    const strip = $("#status-strip");
    const onHome = !location.hash || location.hash === "#/" || location.hash === "#";
    if (strip && !strip.classList.contains("online") && onHome && view.scrollTop < 40) route();
  });
