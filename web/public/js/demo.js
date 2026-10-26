/**
 * Catálogo local de muestra.
 *
 * No es contenido de ningún addon: son fichas de dominio público con pósters
 * SVG generados aquí mismo. Su única función es que ZX pinte una interfaz
 * completa (héroe, filas, detalle, streams) aunque Cinemeta u otros addons
 * no respondan — por ejemplo en una preview sin salida a internet.
 *
 * En cuanto un addon real devuelve metas, app.js sustituye este tablero.
 */

const PALETTES = [
  ["#00a8e1", "#0b1a36", "#c44bff"],
  ["#ff8a3d", "#2a0f2e", "#ffd36b"],
  ["#3ee0a0", "#062a2a", "#00a8e1"],
  ["#c44bff", "#180a2a", "#ff5d73"],
  ["#ffd36b", "#241608", "#ff7eb3"],
  ["#00a8e1", "#071b2b", "#7dffb3"],
];

function xml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function uri(svg) {
  // Sin comillas sueltas: se usa dentro de url('…') en estilos en línea.
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg).replace(/'/g, "%27");
}

function wrap(title, max = 14) {
  const words = String(title).toUpperCase().split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > max && line) {
      lines.push(line);
      line = w;
    } else {
      line = (line + " " + w).trim();
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

function poster(name, year, i) {
  const [a, b, c] = PALETTES[i % PALETTES.length];
  const lines = wrap(name);
  const y0 = 360 - (lines.length - 1) * 22;
  const text = lines
    .map((l, k) => `<text x="34" y="${y0 + k * 44}" font-family="Impact,Arial Narrow,sans-serif" font-size="42" letter-spacing="1" fill="#fff">${xml(l)}</text>`)
    .join("");
  return uri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 600">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${b}"/><stop offset="1" stop-color="#05070b"/></linearGradient>
      <radialGradient id="r" cx="0.75" cy="0.22" r="0.65"><stop stop-color="${a}" stop-opacity="0.85"/><stop offset="1" stop-color="${a}" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="400" height="600" fill="url(#g)"/>
    <circle cx="310" cy="120" r="190" fill="url(#r)"/>
    <path d="M0 430 L400 340 L400 600 L0 600 Z" fill="#000" opacity="0.35"/>
    <circle cx="70" cy="110" r="46" fill="none" stroke="${c}" stroke-width="3" opacity="0.7"/>
    <circle cx="70" cy="110" r="18" fill="${c}" opacity="0.55"/>
    ${text}
    <text x="34" y="524" font-family="monospace" font-size="15" letter-spacing="2" fill="${a}" opacity="0.85">${xml(year)} · ZX DEMO</text>
  </svg>`);
}

function backdrop(name, i) {
  const [a, b, c] = PALETTES[i % PALETTES.length];
  return uri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${b}"/><stop offset="0.55" stop-color="#05070b"/><stop offset="1" stop-color="#000"/></linearGradient>
      <radialGradient id="r" cx="0.72" cy="0.35" r="0.6"><stop stop-color="${a}" stop-opacity="0.65"/><stop offset="1" stop-color="${a}" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="1600" height="900" fill="url(#g)"/>
    <ellipse cx="1180" cy="290" rx="520" ry="400" fill="url(#r)"/>
    <g fill="none" stroke="${c}" stroke-width="2" opacity="0.4">
      <circle cx="1210" cy="300" r="170"/><circle cx="1210" cy="300" r="250"/><circle cx="1210" cy="300" r="340"/>
    </g>
    <path d="M0 740 L1600 560 L1600 900 L0 900 Z" fill="#000" opacity="0.5"/>
    <text x="1500" y="840" text-anchor="end" font-family="monospace" font-size="20" letter-spacing="6" fill="#fff" opacity="0.35">${xml(name.toUpperCase())}</text>
  </svg>`);
}

const SEED = [
  {
    name: "Nosferatu", year: 1922, type: "movie", genres: ["Terror", "Mudo"],
    runtime: "94 min", description: "El vampiro de Murnau sigue siendo la referencia del cine de terror. Una copia restaurada de dominio público para probar la ficha, los streams y el reproductor de ZX.",
  },
  {
    name: "Metrópolis", year: 1927, type: "movie", genres: ["Ciencia ficción", "Mudo"],
    runtime: "153 min", description: "La ciudad del futuro de Fritz Lang. Ciencia ficción expresionista en dominio público, ideal para comprobar cómo se muestran las fichas largas.",
  },
  {
    name: "El acorazado Potemkin", year: 1925, type: "movie", genres: ["Drama", "Histórica"],
    runtime: "75 min", description: "Eisenstein y el montaje que cambió el cine. Incluida en la muestra local para que la interfaz tenga contenido incluso sin red.",
  },
  {
    name: "Viaje a la Luna", year: 1902, type: "movie", genres: ["Aventura", "Fantasía"],
    runtime: "13 min", description: "Méliès y su cohete en la Luna: el inicio del cine de ciencia ficción. Un clásico corto de dominio público.",
  },
  {
    name: "El gabinete del doctor Caligari", year: 1920, type: "movie", genres: ["Terror", "Mudo"],
    runtime: "76 min", description: "El expresionismo alemán en estado puro. Sus decorados pintados inspiran los pósters generados de esta muestra.",
  },
  {
    name: "El general", year: 1926, type: "movie", genres: ["Comedia", "Acción"],
    runtime: "107 min", description: "Buster Keaton, una locomotora y las mejores persecuciones del cine mudo. Dominio público.",
  },
  {
    name: "La noche de los muertos vivientes", year: 1968, type: "movie", genres: ["Terror", "Culto"],
    runtime: "96 min", description: "El clásico de George A. Romero que definió el cine zombi moderno. Sin derechos de explotación desde su estreno.",
  },
  {
    name: "Charada", year: 1963, type: "movie", genres: ["Suspense", "Comedia"],
    runtime: "113 min", description: "Audrey Hepburn y Cary Grant en la comedia de intriga de Stanley Donen. Dominio público en Estados Unidos.",
  },
  {
    name: "Sherlock Jr.", year: 1924, type: "movie", genres: ["Comedia", "Fantasía"],
    runtime: "45 min", description: "Buster Keaton entra en la pantalla de cine. Una lección de montaje en menos de una hora.",
  },
  {
    name: "Plan 9 del espacio exterior", year: 1959, type: "movie", genres: ["Ciencia ficción", "Culto"],
    runtime: "79 min", description: "La joya involuntaria de Ed Wood. Perfecta para una sesión de cine de medianoche.",
  },
  {
    name: "Popeye contra Sindbad", year: 1936, type: "movie", genres: ["Animación", "Aventura"],
    runtime: "16 min", description: "El corto de animación de los estudios Fleischer en Technicolor. Dominio público y lleno de color.",
  },
  {
    name: "His Girl Friday", year: 1940, type: "movie", genres: ["Comedia", "Periodismo"],
    runtime: "92 min", description: "Diálogos a mil por hora en la comedia de Howard Hawks. Una de las grandes comedias de dominio público.",
  },
];

const SERIES = [
  {
    name: "ZX · Episodios de prueba", year: 2026, type: "series", genres: ["Prueba"],
    runtime: "3 episodios", description: "Serie ficticia incluida en la muestra local para probar el selector de temporadas, la lista de episodios y la navegación a streams.",
    seasons: 2,
  },
  {
    name: "Archivo ZX · Documentales", year: 2026, type: "series", genres: ["Documental", "Prueba"],
    runtime: "2 episodios", description: "Otra serie de muestra con dos temporadas. No descarga nada: sólo sirve para comprobar que la interfaz renderiza episodios sin red.",
    seasons: 2,
  },
];

function hydrate(item, i) {
  const id = "zx-demo-" + String(item.name).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const meta = {
    id,
    type: item.type,
    name: item.name,
    year: item.year,
    releaseInfo: String(item.year),
    genres: item.genres,
    runtime: item.runtime,
    description: item.description,
    poster: poster(item.name, item.year, i),
    background: backdrop(item.name, i),
    _demo: true,
  };
  if (item.seasons) {
    meta.videos = Array.from({ length: item.seasons * 3 }, (_, k) => ({
      id: `${id}:${Math.floor(k / 3) + 1}:${(k % 3) + 1}`,
      season: Math.floor(k / 3) + 1,
      episode: (k % 3) + 1,
      title: `Episodio ${(k % 3) + 1}`,
      overview: "Episodio de muestra local; no se descarga ningún vídeo.",
      released: `${item.year}-01-01`,
    }));
  }
  return meta;
}

export const DEMO_MOVIES = SEED.map(hydrate);
export const DEMO_SERIES = SERIES.map((s, i) => hydrate(s, i + 4));
export const DEMO_ALL = [...DEMO_MOVIES, ...DEMO_SERIES];

export const DEMO_ROWS = [
  { title: "Muestra local · Imprescindibles", metas: DEMO_MOVIES.slice(0, 8) },
  { title: "Muestra local · Cine clásico", metas: [...DEMO_MOVIES.slice(8), ...DEMO_MOVIES.slice(2, 6)] },
  { title: "Muestra local · Series y episodios", metas: DEMO_SERIES },
];

export function isDemoId(id) {
  return typeof id === "string" && id.startsWith("zx-demo-");
}

export function demoMeta(id) {
  return DEMO_ALL.find((m) => m.id === id || id.startsWith(m.id + ":")) || null;
}

export function demoSearch(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return DEMO_ALL.slice(0, 12);
  return DEMO_ALL.filter((m) =>
    [m.name, m.description, ...(m.genres || [])].join(" ").toLowerCase().includes(q)
  );
}

/**
 * Streams de muestra. Son fuentes públicas de prueba: necesitan internet,
 * pero permiten comprobar la resolución y el reproductor HLS local.
 */
export function demoStreams(id) {
  const meta = demoMeta(id);
  const title = meta?.name || "ZX Demo";
  return [
    {
      name: "ZX Demo · HLS",
      title: `${title} · stream de prueba HLS (requiere internet)`,
      url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
      type: "hls",
      behaviorHints: { notWebReady: false },
      _addon: "ZX · Muestra local",
    },
    {
      name: "ZX Demo · MP4",
      title: `${title} · vídeo de prueba MP4 (requiere internet)`,
      url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
      behaviorHints: { notWebReady: false },
      _addon: "ZX · Muestra local",
    },
  ];
}
