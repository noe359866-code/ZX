/**
 * ============================================================================
 *  UnlimPlay Proxy Stream — Addon Proxy de Stremio (Cloudflare Worker)
 * ============================================================================
 *
 *  Worker en formato ES Module que actúa como addon de Stremio:
 *
 *    GET /manifest.json                → manifiesto oficial del addon
 *    GET /stream/movie/{id}.json       → extrae el .m3u8 del embed de unlimplay
 *    GET /proxy?url=<m3u8|segmento>    → (opcional) pasarela HLS desde el edge
 *    OPTIONS *                         → preflight CORS
 *
 *  Flujo del endpoint /stream:
 *    1. Limpia el id recibido (quita prefijos "tmdb:", "movie:", ".json", etc.).
 *    2. Pide https://unlimplay.com/f/embed/movie/{id} desde el edge de
 *       Cloudflare con un User-Agent de navegador moderno + Referer.
 *    3. Normaliza el HTML (des-escapa "\/", "\u002F", "&#47;", concatenaciones
 *       JS tipo "a" + "b") y extrae la URL .m3u8 con expresiones regulares
 *       ordenadas por confianza.
 *    4. Devuelve la respuesta de Stremio con `behaviorHints.requestHeaders`
 *       para que el cliente reproduzca el HLS con Referer/UA correctos.
 *    5. Si algo falla → SIEMPRE {"streams": []} (nunca rompe el addon).
 *
 *  Variables de entorno (opcionales, en el panel de Workers → Settings):
 *    PROXY_HLS     "1" → la URL del stream apunta a /proxy (útil en Stremio Web,
 *                        que no puede inyectar cabeceras).   Por defecto "0".
 *    DEEP_SCAN     "1" → si el HTML no trae el .m3u8, sigue hasta 2 peticiones
 *                        de configuración/API del reproductor. Por defecto "1".
 *    MAX_STREAMS   "3" → cuántos candidatos .m3u8 devolver como streams.
 *    NOT_WEB_READY "1" → marca el stream como no reproducible en navegador
 *                        (correcto cuando se depende de requestHeaders).
 *    SOURCE_ORIGIN     → origen del embed. Por defecto "https://unlimplay.com".
 *    EMBED_PATH        → ruta del embed. Por defecto "/f/embed/movie/".
 *
 *  Este archivo es 100 % autocontenido: se puede pegar tal cual en el editor
 *  del panel de Cloudflare Workers (Create Worker → pegar → Deploy).
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// 1. Constantes de configuración
// ---------------------------------------------------------------------------

/** Identidad del addon según el protocolo de Stremio. */
const ADDON = Object.freeze({
  id: 'com.cf.unlimplay.proxy',
  name: 'UnlimPlay Proxy Stream',
  version: '1.0.0',
  description:
    'Addon proxy que resuelve flujos HLS (.m3u8) desde el embed de UnlimPlay en el edge de Cloudflare.',
  resources: ['stream'],
  types: ['movie'],
  idPrefixes: ['tt', 'tmdb:'],
  contactEmail: 'addon@example.com',
});

/**
 * Origen de vídeo embebido (valores por defecto exigidos por el addon).
 * Se pueden sobrescribir por variables de entorno porque este tipo de dominios
 * rota con frecuencia: así se cambia sin tocar el código.
 *   SOURCE_ORIGIN  → "https://unlimplay.com"
 *   EMBED_PATH     → "/f/embed/movie/"
 */
const SOURCE_DEFAULTS = Object.freeze({
  origin: 'https://unlimplay.com',
  embedPath: '/f/embed/movie/',
});

/** User-Agent de navegador moderno (se usa para scrapear y para reproducir). */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/**
 * Resuelve la configuración del origen de vídeo a partir del entorno.
 *
 * @param {object} [env]
 * @returns {{origin: string, referer: string, embedPath: string, embedUrl: (id: string) => string}}
 */
export function resolveSource(env) {
  const origin = String(env?.SOURCE_ORIGIN || SOURCE_DEFAULTS.origin)
    .trim()
    .replace(/\/+$/, '');

  let embedPath = String(env?.EMBED_PATH || SOURCE_DEFAULTS.embedPath).trim();
  if (!embedPath.startsWith('/')) embedPath = `/${embedPath}`;
  if (!embedPath.endsWith('/')) embedPath = `${embedPath}/`;

  return {
    origin,
    referer: `${origin}/`,
    embedPath,
    embedUrl: (id) => `${origin}${embedPath}${encodeURIComponent(id)}`,
  };
}

/** Cabeceras que Stremio/ffmpeg deben enviar al pedir el .m3u8 y sus segmentos. */
function playbackHeaders(source) {
  return {
    Referer: source.referer,
    'User-Agent': BROWSER_UA,
    Origin: source.origin,
    'Accept-Language': 'en-US,en;q=0.9',
  };
}

/**
 * Cabeceras usadas al scrapear el embed desde el Worker: imitan la carga de un
 * <iframe> desde un sitio de terceros, que es el contexto real del reproductor.
 */
function scrapeHeaders(source) {
  return {
    'User-Agent': BROWSER_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: source.referer,
    Origin: source.origin,
    'Sec-Fetch-Dest': 'iframe',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'cross-site',
    'Upgrade-Insecure-Requests': '1',
  };
}

/** Cabeceras CORS exigidas por Stremio (el addon se instala desde otro origen). */
const CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, User-Agent, Referer, Origin, Range, Accept, X-Requested-With',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, X-Proxy-Error',
  'Access-Control-Max-Age': '86400',
});

/** Límites defensivos del Worker. */
const LIMITS = Object.freeze({
  fetchTimeoutMs: 9_000, // aborta peticiones colgadas
  maxBodyChars: 3_000_000, // no procesamos HTML gigante
  maxDeepScanRequests: 2, // peticiones extra para buscar el .m3u8
  defaultMaxStreams: 3, // candidatos alternativos devueltos
});

// ---------------------------------------------------------------------------
// 2. Expresiones regulares de extracción
// ---------------------------------------------------------------------------

/**
 * Patrón A (máxima confianza): la URL aparece asociada a una clave típica de
 * reproductor (JWPlayer, Plyr, Video.js, Clappr, hls.js…).
 *   file: "https://cdn/x/master.m3u8?token=..."
 *   sources:[{src:"//cdn/x/index.m3u8"}]
 */
const KEYED_M3U8_RE =
  /(?:file|src|source|sources|url|hls(?:_?url)?|video(?:_?url)?|play(?:_?url)?|stream(?:_?url)?|playlist|manifest|m3u8|link|media|path)\s*[:=]\s*["'`]\s*((?:https?:)?\/\/[^"'`\s<>\\]+?\.m3u8(?:\?[^"'`\s<>\\]*)?)\s*["'`]/gi;

/** Patrón B (confianza media): cualquier literal entrecomillado con .m3u8. */
const QUOTED_M3U8_RE =
  /["'`]\s*((?:https?:)?\/\/[^"'`\s<>\\]+?\.m3u8(?:\?[^"'`\s<>\\]*)?)\s*["'`]/gi;

/**
 * Patrón C (confianza baja): URL suelta sin comillas (JSON minificado, logs…).
 * - `(?<!:)` evita "robar" las barras de otro esquema (ftp://, rtsp://, blob:).
 * - El lookahead final exige un delimitador tras ".m3u8" para no recortar URLs
 *   mayores (p.ej. ".../a.m3u8backup/file.bin" NO debe dar ".../a.m3u8").
 */
const BARE_M3U8_RE =
  /(?<!:)((?:https?:)?\/\/[^\s"'`<>\\)\]},;]+?\.m3u8(?:\?[^\s"'`<>\\)\]},;]*)?)(?=$|[\s"'`,;:)}\]<])/gi;

/**
 * Patrón D (último recurso): fragmento ".m3u8" relativo, sin barras ni esquema.
 * Aparece cuando el embed construye la URL concatenando variables:
 *   var base = "https://cdn/x/"; var file = base + "master.m3u8" + "?t=1";
 */
const RELATIVE_M3U8_RE = /["'`]([^"'`\s<>\\/:]+\.m3u8(?:\?[^"'`\s<>\\]*)?)["'`]/gi;

/** Prefijos base absolutos terminados en "/" presentes en el documento. */
const BASE_PREFIX_RE = /["'`]((?:https?:)?\/\/[^"'`\s<>\\]*?\/)["'`]/gi;


/**
 * Endpoints de configuración usados en el "deep scan" cuando el HTML no
 * contiene el .m3u8 directamente (el reproductor lo pide por XHR/fetch).
 */
const CONFIG_URL_RE =
  /["'`]((?:https?:)?\/\/[^"'`\s<>\\]+?\.(?:json|php|aspx?|do)(?:\?[^"'`\s<>\\]*)?|\/[^"'`\s<>\\]*(?:api|source|player|token|video|hls|stream|config)[^"'`\s<>\\]*)["'`]/gi;

/** Pesos por patrón: definen el orden de preferencia de los candidatos. */
const PATTERN_SCORES = [
  { re: KEYED_M3U8_RE, score: 100 },
  { re: QUOTED_M3U8_RE, score: 60 },
  { re: BARE_M3U8_RE, score: 30 },
];

// ---------------------------------------------------------------------------
// 3. Utilidades genéricas
// ---------------------------------------------------------------------------

/** Convierte un valor de entorno a booleano ("1", "true", "yes", "on"). */
function envFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

/** Convierte un valor de entorno a entero positivo con valor por defecto. */
function envInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Sanea un valor de cabecera: HTTP sólo admite ByteString (Latin-1).
 * Sin esto, un mensaje de error con "→" o emojis tumbaría la respuesta.
 *
 * @param {string} value
 * @returns {string}
 */
function safeHeaderValue(value) {
  return String(value ?? '')
    .replace(/[^\x20-\x7E\x80-\xFF]/g, '') // fuera de Latin-1 imprimible
    .replace(/[\r\n]/g, ' ') // anti header-injection
    .trim();
}

/** Respuesta JSON con cabeceras CORS ya aplicadas. */
function jsonResponse(payload, status = 200, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...CORS_HEADERS,
  };
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers[key] = safeHeaderValue(value);
  }

  return new Response(JSON.stringify(payload), { status, headers });
}

/**
 * Limpia el id que llega en la ruta.
 * Soporta: "tt1234567.json", "tmdb:1234", "tmdb:movie:1234", "imdb:tt123", "%20".
 *
 * @param {string} rawId
 * @returns {string} id saneado ("" si no es utilizable)
 */
export function cleanId(rawId) {
  let id = String(rawId ?? '').trim();

  // Quitamos query/hash y la extensión ".json" del protocolo de Stremio.
  id = id.split('?')[0].split('#')[0];
  try {
    id = decodeURIComponent(id.replace(/\+/g, ' ')).trim();
  } catch {
    // Secuencia %-escapada inválida: descartamos los escapes rotos.
    id = id.replace(/%[0-9A-Fa-f]{0,2}/g, '').trim();
  }
  id = id.replace(/\.json$/i, '');

  // Eliminamos prefijos de proveedor/tipo encadenados: "tmdb:movie:1234" → "1234".
  const PREFIX_RE = /^(?:tmdb|imdb|tvdb|cinemeta|wf|movie|series|tv|channel)\s*:\s*/i;
  let guard = 0;
  while (PREFIX_RE.test(id) && guard++ < 5) id = id.replace(PREFIX_RE, '');

  // Un id externo sólo contiene alfanuméricos, "_" y "-".
  const match = id.match(/[A-Za-z0-9_-]+/);
  return match ? match[0] : '';
}

/**
 * Des-escapa el HTML/JS devuelto por el embed para que las regex puedan leerlo.
 * Devuelve dos variantes:
 *   - clean: con escapes de JSON/HTML resueltos ("https:\/\/x" → "https://x").
 *   - flat : además une concatenaciones JS ("https://x/" + "a.m3u8").
 *
 * @param {string} raw
 * @returns {{clean: string, flat: string}}
 */
export function normalizeSource(raw) {
  let s = String(raw ?? '');

  s = s
    .replace(/\\u002F/gi, '/') // \u002F → /
    .replace(/\\u0026/gi, '&') // \u0026 → &
    .replace(/\\x2F/gi, '/') // \x2F   → /
    .replace(/&#0*47;/g, '/') // &#47;  → /
    .replace(/&#x0*2F;/gi, '/') // &#x2F; → /
    .replace(/&sol;/gi, '/') // &sol;  → /
    .replace(/\\\//g, '/') // \/     → /  (el caso más común)
    .replace(/\\"/g, '"') // \"     → "
    .replace(/\\'/g, "'") // \'     → '
    .replace(/&amp;/gi, '&'); // &amp;  → &

  const flat = s
    .replace(/(["'`])\s*\+\s*(["'`])/g, '') // "a" + "b"  → ab
    .replace(/\\+/g, ''); // restos de escapes

  return { clean: s, flat };
}

/**
 * Convierte una URL (posiblemente relativa o "protocol-relative") en absoluta.
 *
 * @param {string} rawUrl
 * @param {string} baseUrl URL del documento donde se encontró
 * @returns {string|null}
 */
export function absolutize(rawUrl, baseUrl) {
  let u = String(rawUrl ?? '').trim();
  if (!u) return null;

  // Elimina puntuación sobrante pegada al final de la URL.
  u = u.replace(/^[)\]}'"`<]+/, '').replace(/[.,;:)\]}'"`<]+$/, '');
  if (!u) return null;

  // "//cdn.example.com/x.m3u8" → "https://cdn.example.com/x.m3u8"
  if (u.startsWith('//')) u = `https:${u}`;

  try {
    const abs = new URL(u, baseUrl);
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
    if (!abs.hostname.includes('.')) return null;
    return abs.toString();
  } catch {
    return null;
  }
}

/** Puntúa un candidato para ordenar los resultados de mayor a menor confianza. */
function rankUrl(url, baseScore, sourceHost) {
  let score = baseScore;
  try {
    const u = new URL(url);
    // Un CDN distinto del host del embed suele ser el stream real.
    if (u.hostname !== sourceHost) score += 5;
    // Nombres típicos de playlist maestra.
    if (/master|index|playlist|chunklist|manifest/i.test(u.pathname)) score += 3;
    // Tokens de firma: señal de URL "viva".
    if (/\b(token|sign|signature|hash|expire|key|auth)\b/i.test(u.search)) score += 2;
  } catch {
    /* no-op */
  }
  return score;
}

/**
 * Recoge literales entrecomillados que son URLs terminadas en "/" (bases de
 * concatenación) y que apuntan a un directorio real, no a la raíz del host.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string[]}
 */
function collectBasePrefixes(text, max = 12) {
  const out = [];
  const seen = new Set();
  BASE_PREFIX_RE.lastIndex = 0;
  let m;
  while ((m = BASE_PREFIX_RE.exec(text)) !== null) {
    if (BASE_PREFIX_RE.lastIndex === m.index) BASE_PREFIX_RE.lastIndex++;
    const raw = m[1];
    if (seen.has(raw)) continue;
    seen.add(raw);
    try {
      const u = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
      // Exigimos al menos un segmento de ruta: descarta "https://host/" a secas.
      if (u.pathname.replace(/\/+$/, '') === '') continue;
    } catch {
      continue;
    }
    out.push(raw);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Recoge fragmentos ".m3u8" relativos (nombre de fichero + query opcional).
 *
 * @param {string} text
 * @param {number} max
 * @returns {string[]}
 */
function collectRelativeFragments(text, max = 6) {
  const out = [];
  const seen = new Set();
  RELATIVE_M3U8_RE.lastIndex = 0;
  let m;
  while ((m = RELATIVE_M3U8_RE.exec(text)) !== null) {
    if (RELATIVE_M3U8_RE.lastIndex === m.index) RELATIVE_M3U8_RE.lastIndex++;
    const frag = m[1];
    if (!frag || seen.has(frag)) continue;
    seen.add(frag);
    out.push(frag);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Extrae y ordena todas las URLs .m3u8 encontradas en un documento.
 *
 * @param {string} rawHtml HTML/JS/JSON de la página del reproductor
 * @param {string} baseUrl URL del documento (para resolver relativas)
 * @param {{max?: number}} [opts]
 * @returns {string[]} URLs absolutas, deduplicadas y ordenadas por confianza
 */
export function extractM3u8Urls(rawHtml, baseUrl, opts = {}) {
  const max = opts.max ?? LIMITS.defaultMaxStreams * 4;
  let sourceHost = '';
  try {
    sourceHost = new URL(baseUrl).hostname;
  } catch {
    /* baseUrl inválida: seguimos, sólo afecta al ranking */
  }

  const { clean, flat } = normalizeSource(rawHtml);
  const candidates = new Map(); // url → score

  const add = (rawUrl, baseScore) => {
    const abs = absolutize(rawUrl, baseUrl);
    if (!abs) return;
    // Validación final: el pathname debe terminar en .m3u8.
    try {
      if (!new URL(abs).pathname.toLowerCase().endsWith('.m3u8')) return;
    } catch {
      return;
    }
    const score = rankUrl(abs, baseScore, sourceHost);
    // Nos quedamos siempre con la mejor puntuación de cada URL.
    if (!candidates.has(abs) || candidates.get(abs) < score) candidates.set(abs, score);
  };

  // Recorremos las dos variantes normalizadas (clean puntúa un poco más alto).
  const variants = [
    { text: clean, bonus: 10 },
    { text: flat, bonus: 0 },
  ];

  for (const { text, bonus } of variants) {
    for (const { re, score } of PATTERN_SCORES) {
      re.lastIndex = 0; // las regex son /g: reseteamos el cursor
      let m;
      while ((m = re.exec(text)) !== null) {
        const captured = m[1] ?? m[0];
        add(captured, score + bonus);
        if (re.lastIndex === m.index) re.lastIndex++; // evita bucles infinitos
      }
    }
  }

  // --- Patrón D: reconstrucción de URLs armadas por concatenación -----------
  // Sólo se activa si no apareció ninguna URL absoluta, para no contaminar los
  // resultados con falsos positivos cuando ya tenemos una coincidencia buena.
  if (candidates.size === 0) {
    const bases = [...new Set([...collectBasePrefixes(clean), ...collectBasePrefixes(flat)])];
    const fragments = [
      ...new Set([...collectRelativeFragments(clean), ...collectRelativeFragments(flat)]),
    ];
    for (const fragment of fragments) {
      for (const base of bases) {
        add(base + fragment, 45);
      }
    }
  }

  return [...candidates.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, max)
    .map(([url]) => url);
}

/**
 * Busca URLs de configuración/API en el HTML (para el deep scan).
 *
 * @param {string} rawHtml
 * @param {string} baseUrl
 * @returns {string[]}
 */
export function findConfigUrls(rawHtml, baseUrl) {
  const { clean } = normalizeSource(rawHtml);
  const out = [];
  const seen = new Set();

  CONFIG_URL_RE.lastIndex = 0;
  let m;
  while ((m = CONFIG_URL_RE.exec(clean)) !== null) {
    // Protección contra coincidencias vacías (bucle infinito con /g).
    if (CONFIG_URL_RE.lastIndex === m.index) CONFIG_URL_RE.lastIndex++;

    const abs = absolutize(m[1], baseUrl);
    if (!abs || seen.has(abs)) continue;
    // Ignoramos recursos estáticos: sólo nos interesan endpoints de datos.
    if (/\.(?:js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|mp4|ts)(?:$|\?)/i.test(abs)) continue;

    seen.add(abs);
    out.push(abs);
    if (out.length >= 8) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Cliente HTTP del edge
// ---------------------------------------------------------------------------

/**
 * Recorta un documento conservando cabeza y cola.
 * Los reproductores embebidos se configuran al principio (JWPlayer) o al final
 * del HTML (hls.js / fetch de configuración), así que un corte simple por la
 * cabeza dejaría fuera el .m3u8 en páginas grandes.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
export function truncateSmart(text, maxChars = LIMITS.maxBodyChars) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return s;
  const half = Math.floor(maxChars / 2);
  return `${s.slice(0, half)}\n/* contenido recortado por el Worker */\n${s.slice(-half)}`;
}

/**
 * fetch() con timeout, cabeceras de navegador y límite de tamaño.
 *
 * @param {string} url
 * @param {Record<string,string>} headers
 * @param {number} timeoutMs
 * @returns {Promise<{body: string, response: Response}>}
 */
async function fetchText(url, headers, timeoutMs = LIMITS.fetchTimeoutMs) {
  const response = await fetch(url, {
    method: 'GET',
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} en ${url}`);
  }

  return { body: truncateSmart(await response.text()), response };
}

// ---------------------------------------------------------------------------
// 5. Manifiesto y objetos de stream de Stremio
// ---------------------------------------------------------------------------

/**
 * Construye el manifiesto oficial del addon.
 *
 * @param {object} [env] variables de entorno (permiten cambiar el origen)
 * @returns {object} manifest de Stremio
 */
export function buildManifest(env) {
  const source = resolveSource(env);
  return {
    id: ADDON.id,
    version: ADDON.version,
    name: ADDON.name,
    description: ADDON.description,
    logo: `${source.origin}/favicon.ico`,
    background: `${source.origin}/assets/images/background.jpg`,
    resources: [...ADDON.resources],
    types: [...ADDON.types],
    idPrefixes: [...ADDON.idPrefixes],
    behaviorHints: { configurable: false, configurationRequired: false },
  };
}

/**
 * Construye el objeto `stream` que consume Stremio.
 *
 * @param {string} m3u8Url URL absoluta del .m3u8
 * @param {number} index   posición del candidato (0 = principal)
 * @param {URL} workerUrl URL del propio Worker (para el modo proxy)
 * @param {object} env    variables de entorno
 * @returns {object}
 */
function buildStream(m3u8Url, index, workerUrl, env) {
  const source = resolveSource(env);
  const useProxy = envFlag(env?.PROXY_HLS, false);
  const notWebReady = useProxy ? false : envFlag(env?.NOT_WEB_READY, true);

  // En modo proxy el Worker hace de pasarela HLS e inyecta él las cabeceras,
  // así el cliente no necesita soportar requestHeaders (Stremio Web incluido).
  const finalUrl = useProxy
    ? `${workerUrl.origin}/proxy?url=${encodeURIComponent(m3u8Url)}`
    : m3u8Url;

  // El candidato principal usa el título exigido; los alternativos se etiquetan.
  const title =
    index === 0 ? 'UnlimPlay 1080p [HLS Edge]' : `UnlimPlay 1080p [HLS Edge · Alt ${index + 1}]`;

  return {
    name: ADDON.name,
    title,
    type: 'hls',
    url: finalUrl,
    behaviorHints: {
      // Stremio usa notSupported=false para marcar el stream como reproducible.
      notSupported: false,
      // Evita que se muestre en Stremio Web cuando depende de cabeceras propias.
      notWebReady,
      // Cabeceras que el reproductor debe enviar al pedir el HLS.
      requestHeaders: {
        Referer: source.referer,
        'User-Agent': BROWSER_UA,
      },
      // Formato moderno equivalente (Stremio >= 1.6 usa proxyHeaders).
      proxyHeaders: {
        request: {
          Referer: source.referer,
          'User-Agent': BROWSER_UA,
          Origin: source.origin,
        },
      },
      // Agrupa las variantes del mismo origen en la UI de Stremio.
      bingeGroup: `unlimplay-${index}`,
    },
  };
}

// ---------------------------------------------------------------------------
// 6. Endpoint /stream — scraping + extracción del .m3u8
// ---------------------------------------------------------------------------

/**
 * Resuelve `/stream/movie/{id}.json`.
 *
 * @param {string} rawId
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response>}
 */
async function handleStream(rawId, request, env) {
  const id = cleanId(rawId);

  // Id inválido → respuesta vacía válida (Stremio no debe recibir un error 500).
  if (!id) return jsonResponse({ streams: [] }, 200, { 'X-Proxy-Error': 'bad-id' });

  const source = resolveSource(env);
  const embedUrl = source.embedUrl(id);
  const headers = scrapeHeaders(source);
  const workerUrl = new URL(request.url);
  const maxStreams = envInt(env?.MAX_STREAMS, LIMITS.defaultMaxStreams);

  try {
    // 1) Petición al embed desde el edge con UA + Referer de navegador.
    const { body: html } = await fetchText(embedUrl, headers);

    // 2) Extracción por regex sobre el HTML/JS normalizado.
    let urls = extractM3u8Urls(html, embedUrl, { max: maxStreams * 4 });

    // 3) Fallback: el reproductor puede cargar el .m3u8 por XHR desde un
    //    endpoint de configuración. Lo intentamos con un número acotado de
    //    peticiones extra para no disparar la latencia del addon.
    if (urls.length === 0 && envFlag(env?.DEEP_SCAN, true)) {
      const configUrls = findConfigUrls(html, embedUrl);
      for (const configUrl of configUrls.slice(0, LIMITS.maxDeepScanRequests)) {
        try {
          const { body } = await fetchText(configUrl, headers);
          const found = extractM3u8Urls(body, configUrl, { max: maxStreams * 4 });
          if (found.length > 0) {
            urls = found;
            break;
          }
        } catch (innerErr) {
          // Un fallo del deep scan nunca aborta la respuesta principal.
          console.warn(`[unlimplay] deep-scan falló en ${configUrl}: ${innerErr?.message}`);
        }
      }
    }

    // 4) Sin candidatos → streams vacío.
    if (urls.length === 0) {
      console.warn(`[unlimplay] sin .m3u8 para id=${id} (${embedUrl})`);
      return jsonResponse({ streams: [] }, 200, { 'X-Proxy-Error': 'not-found' });
    }

    // 5) Respuesta Stremio.
    const streams = urls
      .slice(0, maxStreams)
      .map((url, index) => buildStream(url, index, workerUrl, env));

    return jsonResponse({ streams }, 200, {
      'X-Source-Id': id,
      'X-Candidates-Found': String(urls.length),
    });
  } catch (err) {
    // Cualquier excepción de red/parseo se degrada a streams vacío.
    console.error(`[unlimplay] error resolviendo id=${id}: ${err?.message ?? err}`);
    return jsonResponse({ streams: [] }, 200, {
      'X-Proxy-Error': 'upstream',
      'X-Proxy-Detail': String(err?.message ?? 'unknown').slice(0, 200),
    });
  }
}

// ---------------------------------------------------------------------------
// 7. Endpoint /proxy — pasarela HLS opcional desde el edge
// ---------------------------------------------------------------------------

/**
 * Reescribe un playlist M3U/M3U8 para que todas sus URLs hijas pasen
 * por este mismo Worker (variantes, segmentos, claves DRM y mapas).
 *
 * @param {string} text        contenido del playlist
 * @param {string} playlistUrl URL absoluta del playlist (base de las relativas)
 * @param {string} workerOrigin origen del Worker, p.ej. https://x.workers.dev
 * @returns {string}
 */
export function rewritePlaylist(text, playlistUrl, workerOrigin) {
  const proxify = (childUrl) => {
    const abs = absolutize(childUrl, playlistUrl);
    return abs ? `${workerOrigin}/proxy?url=${encodeURIComponent(abs)}` : null;
  };

  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Directivas (#EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA…) → reescribir URI="…"
      if (trimmed.startsWith('#')) {
        return trimmed.replace(/URI\s*=\s*"([^"]+)"/gi, (match, uri) => {
          const rewritten = proxify(uri);
          return rewritten ? `URI="${rewritten}"` : match;
        });
      }

      // Línea de recurso (variante o segmento).
      const rewritten = proxify(trimmed);
      return rewritten ?? line;
    })
    .join('\n');
}

/**
 * Pasarela genérica: `/proxy?url=<URL codificada>`.
 * - Si el recurso es un playlist → lo reescribe.
 * - Si es un segmento (.ts/.m4s/…) → lo reenvía en streaming con soporte Range.
 *
 * @param {URL} url
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response>}
 */
async function handleProxy(url, request, env) {
  const target = url.searchParams.get('url') ?? url.searchParams.get('u');
  if (!target) return jsonResponse({ error: 'Falta el parámetro ?url=' }, 400);

  let abs;
  try {
    abs = new URL(target);
  } catch {
    return jsonResponse({ error: 'Parámetro ?url= inválido' }, 400);
  }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') {
    return jsonResponse({ error: 'Sólo se permiten URLs http(s)' }, 400);
  }

  // SSRF básico: no permitimos que el proxy apunte al propio Worker.
  if (abs.origin === url.origin) return jsonResponse({ error: 'Bucle de proxy no permitido' }, 400);

  try {
    const headers = { ...playbackHeaders(resolveSource(env)), Accept: '*/*' };
    const range = request.headers.get('Range');
    if (range) headers.Range = range;

    const upstream = await fetch(abs.toString(), {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(LIMITS.fetchTimeoutMs),
    });

    const contentType = (upstream.headers.get('Content-Type') ?? '').toLowerCase();
    const isPlaylist =
      contentType.includes('mpegurl') ||
      contentType.includes('m3u8') ||
      abs.pathname.toLowerCase().endsWith('.m3u8');

    if (!isPlaylist) {
      // Segmento u otro binario → passthrough preservando estado y Range.
      const passThrough = new Headers({
        'Content-Type': contentType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600',
        ...CORS_HEADERS,
      });
      for (const h of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
        const v = upstream.headers.get(h);
        if (v) passThrough.set(h, v);
      }
      return new Response(upstream.body, { status: upstream.status, headers: passThrough });
    }

    const text = await upstream.text();
    const body = text.trimStart().startsWith('#EXTM3U')
      ? rewritePlaylist(text, abs.toString(), url.origin)
      : text;

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Cache-Control': 'no-store',
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    console.error(`[unlimplay] proxy falló en ${abs}: ${err?.message ?? err}`);
    return jsonResponse({ error: 'No se pudo obtener el recurso' }, 502, {
      'X-Proxy-Error': 'proxy-fetch',
    });
  }
}

/**
 * Consola HTML mínima que se sirve en "/" cuando pide un navegador.
 * Permite comprobar la instalación y probar un id sin instalar Stremio.
 * Sin dependencias ni assets externos: todo va inline.
 *
 * @param {{addon:string,id:string,version:string,source:string,install:string}} info
 * @returns {string}
 */
export function healthHtml(info) {
  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${info.addon} · Stremio Addon</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;padding:2rem 1rem;font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
       background:#0b0f14;color:#e6edf3}
  main{max-width:760px;margin:0 auto}
  h1{font-size:1.5rem;margin:0 0 .25rem}
  .sub{color:#8b949e;margin:0 0 1.5rem}
  code,kbd{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:.1rem .35rem;
       font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;color:#79c0ff}
  .card{background:#0d1117;border:1px solid #21262d;border-radius:12px;padding:1.25rem;margin-bottom:1rem}
  .row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
  input{flex:1 1 240px;min-width:0;padding:.6rem .75rem;border-radius:8px;border:1px solid #30363d;
       background:#010409;color:#e6edf3;font:inherit}
  button{padding:.6rem 1rem;border-radius:8px;border:1px solid #30363d;background:#21262d;color:#e6edf3;
       font:inherit;cursor:pointer}
  button:hover{background:#30363d}
  button.primary{background:#1f6feb;border-color:#1f6feb}
  button.primary:hover{background:#388bfd}
  pre{margin:.75rem 0 0;padding:1rem;border-radius:8px;background:#010409;border:1px solid #21262d;
       overflow:auto;font-size:.8rem;max-height:340px}
  ul{margin:.5rem 0 0;padding-left:1.2rem}
  a{color:#58a6ff}
  .kv{display:grid;grid-template-columns:auto 1fr;gap:.35rem 1rem;margin:0}
  .kv dt{color:#8b949e}
  .kv dd{margin:0;word-break:break-all}
  .pill{display:inline-block;padding:.15rem .6rem;border-radius:999px;background:#1f6feb22;
       border:1px solid #1f6feb55;color:#79c0ff;font-size:.8rem}
</style></head>
<body><main>
  <h1>${info.addon}</h1>
  <p class="sub">Addon proxy de Stremio en Cloudflare Workers · <span class="pill">${info.id}</span>
     <span class="pill">v${info.version}</span></p>

  <div class="card">
    <dl class="kv">
      <dt>Instalar en Stremio</dt><dd><code id="install">${info.install}</code></dd>
      <dt>Origen de vídeo</dt><dd><code>${info.source}</code></dd>
      <dt>Manifiesto</dt><dd><a href="/manifest.json">/manifest.json</a></dd>
    </dl>
    <div class="row" style="margin-top:1rem">
      <button onclick="navigator.clipboard.writeText(document.getElementById('install').textContent)">
        Copiar URL de instalación
      </button>
    </div>
  </div>

  <div class="card">
    <strong>Probar un id</strong>
    <p class="sub" style="margin:.25rem 0 .75rem">
      Acepta <code>tt1234567</code>, <code>tmdb:550</code> o <code>tmdb:movie:550</code>.
    </p>
    <div class="row">
      <input id="mid" placeholder="tt1234567" value="tt1234567" spellcheck="false">
      <button class="primary" onclick="resolver()">Resolver stream</button>
    </div>
    <pre id="out">Pulsa «Resolver stream» para consultar /stream/movie/{id}.json</pre>
  </div>

  <div class="card">
    <strong>Endpoints</strong>
    <ul>
      <li><code>GET /manifest.json</code></li>
      <li><code>GET /stream/movie/{id}.json</code></li>
      <li><code>GET /proxy?url=&lt;m3u8|segmento&gt;</code> — pasarela HLS</li>
      <li><code>OPTIONS *</code> — preflight CORS</li>
    </ul>
  </div>
</main>
<script>
async function resolver(){
  var out = document.getElementById('out');
  var id = document.getElementById('mid').value.trim();
  if(!id){ out.textContent = 'Escribe un id.'; return; }
  out.textContent = 'Consultando /stream/movie/' + encodeURIComponent(id) + '.json …';
  try {
    var t0 = performance.now();
    var res = await fetch('/stream/movie/' + encodeURIComponent(id) + '.json');
    var ms = Math.round(performance.now() - t0);
    var data = await res.json();
    var n = (data.streams || []).length;
    out.textContent = 'HTTP ' + res.status + ' · ' + ms + ' ms · ' + n + ' stream(s)\\n\\n'
      + JSON.stringify(data, null, 2);
  } catch (err) {
    out.textContent = 'Error: ' + (err && err.message ? err.message : err);
  }
}
document.getElementById('mid').addEventListener('keydown', function(e){
  if(e.key === 'Enter') resolver();
});
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// 8. Router principal
// ---------------------------------------------------------------------------

/** /stream/[movie|series|tv]/{id}[.json] */
const STREAM_ROUTE_RE = /^\/stream\/(?:(?:movie|series|tv|channel)\/)?([^/]+)$/i;

export default {
  /**
   * @param {Request} request
   * @param {object} env
   * @param {ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    // Preflight CORS: se responde antes de tocar el router.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse({ error: 'Method Not Allowed' }, 405);
    }

    let url;
    try {
      url = new URL(request.url);
    } catch {
      return jsonResponse({ error: 'Bad Request' }, 400);
    }

    // Normalizamos la ruta (sin trailing slash ni barras duplicadas).
    // `rawPath` conserva las mayúsculas del id; `path` se usa para comparar
    // las rutas estáticas de forma insensible a mayúsculas.
    const rawPath = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    const path = rawPath.toLowerCase();

    try {
      // --- Raíz: healthcheck / consola de pruebas -------------------------
      if (path === '/' || path === '/index.json') {
        const payload = {
          status: 'ok',
          addon: ADDON.name,
          id: ADDON.id,
          version: ADDON.version,
          source: resolveSource(env).origin,
          endpoints: ['/manifest.json', '/stream/movie/{id}.json', '/proxy?url='],
          install: `${url.origin}/manifest.json`,
        };

        // Navegadores → consola HTML; clientes programáticos → JSON.
        const acceptsHtml = (request.headers.get('Accept') ?? '').includes('text/html');
        if (acceptsHtml && path === '/') {
          return new Response(healthHtml(payload), {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS },
          });
        }
        return jsonResponse(payload);
      }

      // --- Manifiesto del addon -------------------------------------------
      if (path === '/manifest.json') {
        return jsonResponse(buildManifest(env), 200, {
          'Cache-Control': 'public, max-age=3600',
        });
      }

      // --- Streams ---------------------------------------------------------
      // Se compara sobre `rawPath` para no perder mayúsculas del id externo.
      const streamMatch = rawPath.match(STREAM_ROUTE_RE);
      if (streamMatch) {
        // Sólo "movie" es un tipo declarado en el manifest; el resto se acepta
        // por compatibilidad pero se resuelve igualmente contra el embed.
        return await handleStream(streamMatch[1], request, env);
      }

      // --- Pasarela HLS opcional -------------------------------------------
      if (path === '/proxy' || path === '/hls') {
        return await handleProxy(url, request, env);
      }

      // --- 404 amigable -----------------------------------------------------
      return jsonResponse(
        {
          error: 'Not Found',
          hint: 'Rutas válidas: /manifest.json, /stream/movie/{id}.json',
        },
        404,
      );
    } catch (err) {
      // Red de seguridad global: el Worker nunca debe devolver un stack trace.
      console.error(`[unlimplay] error no controlado en ${path}: ${err?.message ?? err}`);
      if (path.startsWith('/stream')) return jsonResponse({ streams: [] }, 200);
      return jsonResponse({ error: 'Internal Server Error' }, 500);
    }
  },
};
