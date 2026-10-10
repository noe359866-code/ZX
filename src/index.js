/**
 * ============================================================================
 *  Vimeus HLS — Addon Proxy de Stremio (Cloudflare Worker)
 * ============================================================================
 *
 *  El Worker resuelve streams HLS únicamente desde Vimeus:
 *    GET /manifest.json                              → manifiesto de Stremio
 *    GET /stream/movie/{id}.json                     → resuelve HLS de película
 *    GET /stream/series/{id}:{season}:{episode}.json → resuelve HLS de episodio
 *    GET /proxy?url=<m3u8|segmento>                  → pasarela HLS opcional
 *
 *  Vimeus usa un embed con VIMEUS_VIEW_KEY. El análisis es estático: no ejecuta
 *  JavaScript ni crea/renueva tokens de sesión. Si la clave no está configurada,
 *  el origen falla o no se encuentra HLS, el addon devuelve {"streams": []} en
 *  lugar de romper Stremio.
 *
 *  La clave Vimeus debe configurarse como secreto del Worker; nunca en Git.
 *  Este archivo es autocontenido y se puede pegar en el panel de Cloudflare.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// 1. Constantes de configuración
// ---------------------------------------------------------------------------

/** Identidad del addon según el protocolo de Stremio. */
const ADDON = Object.freeze({
  // Conservamos el id para que las instalaciones existentes de Stremio sigan
  // reconociendo el addon después de actualizarlo.
  id: 'com.cf.unlimplay.proxy',
  name: 'Vimeus HLS',
  version: '2.0.0',
  description: 'Addon proxy de Stremio que resuelve HLS desde Vimeus.',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'tmdb:'],
  contactEmail: 'addon@example.com',
});

/**
 * Catálogos de Stremio respaldados por la API de listado de Vimeus
 * (GET /api/listing/{movies|series|animes}, cabecera X-API-Key, 50 por página).
 * Sólo se publican en el manifiesto cuando VIMEUS_API_KEY está configurada.
 */
const CATALOGS = Object.freeze([
  { id: 'vimeus-movies', type: 'movie', name: 'Vimeus · Películas', listing: 'movies', field: 'movies' },
  { id: 'vimeus-series', type: 'series', name: 'Vimeus · Series', listing: 'series', field: 'series' },
  { id: 'vimeus-animes', type: 'series', name: 'Vimeus · Anime', listing: 'animes', field: 'animes' },
]);
const LISTING_PAGE_SIZE = 50;
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

const VIMEUS_DEFAULTS = Object.freeze({
  origin: 'https://vimeus.com',
  moviePath: '/e/movie',
  seriesPaths: ['/e/serie', '/e/anime'],
});

/** User-Agent de navegador moderno (se usa para solicitar y reproducir HLS). */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function normalizeOrigin(value, fallback) {
  return String(value || fallback).trim().replace(/\/+$/, '');
}

/** Configuración del proveedor Vimeus. La clave no tiene valor por defecto. */
export function resolveVimeusSource(env) {
  const origin = normalizeOrigin(env?.VIMEUS_ORIGIN, VIMEUS_DEFAULTS.origin);
  const referer = String(env?.VIMEUS_REFERER || `${origin}/`).trim();
  const viewKey = String(env?.VIMEUS_VIEW_KEY || env?.VIEW_KEY || '').trim();
  // API Key de la API de listado (X-API-Key). Opcional: habilita los catálogos.
  const apiKey = String(env?.VIMEUS_API_KEY || '').trim();
  const moviePath = String(env?.VIMEUS_MOVIE_PATH || VIMEUS_DEFAULTS.moviePath).trim();
  const seriesPaths = String(
    env?.VIMEUS_SERIES_PATHS || VIMEUS_DEFAULTS.seriesPaths.join(','),
  )
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean);

  const buildEmbedUrl = (type, id, season, episode, path) => {
    if (!viewKey) return null;
    const url = new URL(path.startsWith('/') ? path : `/${path}`, `${origin}/`);
    const mediaId = String(id);
    url.searchParams.set(/^tt/i.test(mediaId) ? 'imdb' : 'tmdb', mediaId);

    if (type === 'series' || type === 'tv') {
      if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1) {
        throw new Error('Una serie requiere temporada y episodio válidos');
      }
      url.searchParams.set('se', String(season));
      url.searchParams.set('ep', String(episode));
    }

    url.searchParams.set('view_key', viewKey);
    return url.toString();
  };

  const embedUrlsFor = (type, id, season, episode) => {
    const paths = type === 'series' || type === 'tv' ? seriesPaths : [moviePath];
    return paths
      .map((path) => buildEmbedUrl(type, id, season, episode, path))
      .filter(Boolean);
  };

  return {
    key: 'vimeus',
    name: 'Vimeus',
    origin,
    referer,
    viewKey,
    apiKey,
    moviePath,
    seriesPaths,
    embedUrlsFor,
  };
}

/** Alias de compatibilidad: el único proveedor del addon es Vimeus. */
export const resolveSource = resolveVimeusSource;

/**
 * Contexto de reproducción de un HLS: qué Referer/Origin espera su CDN.
 *
 * Vimeus es un agregador: el .m3u8 real lo sirve un host de terceros alcanzado
 * a través de iframes. Ese CDN valida el Referer de *su* página de embed, no el
 * de Vimeus. Si la playlist se encontró en una página de otro origen, usamos
 * ese origen; si se encontró en Vimeus, respetamos VIMEUS_REFERER.
 *
 * @param {object} source proveedor
 * @param {string} [pageUrl] URL de la página donde apareció la playlist
 * @returns {{referer: string, origin: string}}
 */
function playbackContext(source, pageUrl) {
  if (pageUrl) {
    try {
      const page = new URL(pageUrl);
      if ((page.protocol === 'http:' || page.protocol === 'https:') && page.origin !== source.origin) {
        return { referer: `${page.origin}/`, origin: page.origin };
      }
    } catch {
      /* URL inválida: se usa el contexto del proveedor */
    }
  }
  return { referer: source.referer, origin: source.origin };
}

/** Cabeceras que Stremio/ffmpeg deben enviar al pedir el .m3u8 y sus segmentos. */
function playbackHeaders(source, pageUrl) {
  const context = playbackContext(source, pageUrl);
  return {
    Referer: context.referer,
    'User-Agent': BROWSER_UA,
    Origin: context.origin,
    'Accept-Language': 'en-US,en;q=0.9',
  };
}

/**
 * Cabeceras usadas al scrapear el embed desde el Worker: imitan la carga de un
 * <iframe> desde un sitio de terceros, que es el contexto real del reproductor.
 */
function scrapeHeaders(source, referer = source.referer) {
  return {
    'User-Agent': BROWSER_UA,
    Accept: 'text/html,application/xhtml+xml,application/json,application/javascript,text/plain;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: referer,
    Origin: source.origin,
    'Sec-Fetch-Dest': 'iframe',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'cross-site',
    'Upgrade-Insecure-Requests': '1',
  };
}

/** Endpoints que los reproductores piden por XHR/fetch, no como documento. */
const API_LIKE_URL_RE =
  /\.(?:json|php|txt|xml|aspx?)(?:$|\?)|\/(?:api|ajax|v\d+|sources?|getsources?|get_?source|get_?link|config|load|fetch|resolve)(?:\/|$|\?)/i;

/**
 * Cabeceras para endpoints de configuración/API durante el deep scan. Muchos
 * backends exigen `X-Requested-With` y un `Accept` JSON para responder.
 */
function apiHeaders(source, referer = source.referer) {
  return {
    'User-Agent': BROWSER_UA,
    Accept: 'application/json, text/javascript, text/plain, */*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: referer,
    Origin: source.origin,
    'X-Requested-With': 'XMLHttpRequest',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };
}

/** Elige las cabeceras de deep scan según el aspecto de la URL destino. */
function deepScanHeaders(source, targetUrl, referer) {
  let pathAndQuery = targetUrl;
  try {
    const parsed = new URL(targetUrl);
    pathAndQuery = `${parsed.pathname}${parsed.search}`;
  } catch {
    /* se evalúa la cadena completa */
  }
  return API_LIKE_URL_RE.test(pathAndQuery)
    ? apiHeaders(source, referer)
    : scrapeHeaders(source, referer);
}

/** Cabeceras CORS exigidas por Stremio (el addon se instala desde otro origen). */
const CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, User-Agent, Referer, Origin, Range, Accept, X-Requested-With',
  'Access-Control-Expose-Headers':
    'Content-Length, Content-Range, X-Proxy-Error, X-Proxy-Detail, X-Source-Id, X-Candidates-Found, X-Stream-Provider',
  'Access-Control-Max-Age': '86400',
});

/** Límites defensivos del Worker. */
const LIMITS = Object.freeze({
  fetchTimeoutMs: 9_000, // aborta peticiones colgadas
  maxBodyChars: 3_000_000, // no procesamos HTML gigante
  maxDeepScanRequests: 6, // peticiones extra para seguir iframes/configuración (MAX_DEEP_SCAN)
  deepScanConcurrency: 2, // páginas del deep scan que se piden a la vez
  maxConfigUrls: 12, // referencias más prometedoras que se pueden encolar
  defaultMaxStreams: 3, // candidatos alternativos devueltos
  debugHtmlChars: 24_000, // HTML por página que devuelve /debug con html=1
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

/** Rutas relativas explícitamente asociadas a una fuente de vídeo. */
const RELATIVE_KEYED_M3U8_RE =
  /\b(?:file|src|source|url|hls(?:_?url)?|video(?:_?url)?|playlist|manifest|media)\b\s*[:=]\s*["'`]\s*((?:\/|\.\.?\/)[^"'`\s<>\\]*?\.m3u8(?:\?[^"'`\s<>\\]*)?)\s*["'`]/gi;

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

/**
 * Patrón E (HLS sin extensión): una fuente cuyo `type` declara HLS aunque la
 * URL no termine en ".m3u8" (CDNs con rutas tipo /hls/master o /manifest).
 *   sources:[{src:"https://cdn/x/stream", type:"application/x-mpegURL"}]
 *   <source src="https://cdn/x/live" type="application/vnd.apple.mpegurl">
 */
const HLS_TYPE_VALUE = '(?:application\\/(?:x-mpegurl|vnd\\.apple\\.mpegurl)|hls|m3u8)';
const URL_KEYS = '(?:file|src|source|url|hls(?:_?url)?|video(?:_?url)?|stream(?:_?url)?|playlist|manifest|link|media|path)';
const TYPED_URL_BEFORE_RE = new RegExp(
  `\\b${URL_KEYS}\\s*[:=]\\s*["'\`]((?:(?:https?:)?\\/\\/|\\/)[^"'\`\\s<>\\\\]+)["'\`][^{}]{0,200}?\\btype\\s*[:=]\\s*["'\`]${HLS_TYPE_VALUE}["'\`]`,
  'gi',
);
const TYPED_URL_AFTER_RE = new RegExp(
  `\\btype\\s*[:=]\\s*["'\`]${HLS_TYPE_VALUE}["'\`][^{}]{0,200}?\\b${URL_KEYS}\\s*[:=]\\s*["'\`]((?:(?:https?:)?\\/\\/|\\/)[^"'\`\\s<>\\\\]+)["'\`]`,
  'gi',
);

/**
 * Patrón F (HLS por query o formato): la playlist se pide con un parámetro
 * (?format=m3u8, ?type=hls, ?file=…m3u8) o con la sintaxis de Azure Media
 * Services "manifest(format=m3u8-aapl)" en lugar de por extensión.
 */
const QUERY_HLS_RE =
  /["'`]\s*((?:https?:)?\/\/[^"'`\s<>\\?]+?(?:\(format=m3u8|\?[^"'`\s<>\\]*?(?:m3u8|(?:format|type|output|protocol)=hls))[^"'`\s<>\\]*)\s*["'`]/gi;

/** Prefijos base absolutos terminados en "/" presentes en el documento. */
const BASE_PREFIX_RE = /["'`]((?:https?:)?\/\/[^"'`\s<>\\]*?\/)["'`]/gi;

/**
 * Código empaquetado con el "packer" de Dean Edwards:
 *   eval(function(p,a,c,k,e,d){…}('payload',62,123,'a|b|c'.split('|'),0,{}))
 * Se desempaqueta sustituyendo tokens por palabras clave: es una operación de
 * texto, no se evalúa el JavaScript resultante.
 */
const PACKED_JS_RE =
  /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[dr]\s*\)[\s\S]*?\}\s*\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])((?:\\.|(?!\5)[^\\])*)\5\s*\.split\s*\(\s*['"]\|['"]\s*\)/g;

/** Marca de un ".m3u8" escrito al revés (ofuscación por inversión de cadena). */
const REVERSED_M3U8_MARK = /8u3m\./;


/**
 * Endpoints de configuración usados en el "deep scan" cuando el HTML no
 * contiene el .m3u8 directamente (el reproductor lo pide por XHR/fetch).
 */
const CONFIG_URL_RE = /["'`]((?:https?:)?\/\/[^"'`\s<>\\]+|(?:\/|\.\.?\/)[^"'`\s<>\\]+)["'`]/gi;

/** URL de subdocumentos/fuentes que suelen contener el reproductor real. */
const TAG_URL_RE =
  /<(?:iframe|frame|script|source|video|embed|object|track)\b[^>]*?\b(?:src|data-src|data-url|data-file|data-source|href)\s*=\s*(["'`])([^"'`]+)\1/gi;

/** Redirecciones estáticas que a veces llevan al reproductor real. */
const META_REFRESH_RE =
  /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["'][^"'>]*?url\s*=\s*['"]?([^"'\s>]+)/gi;
const LOCATION_REDIRECT_RE =
  /\b(?:(?:window|top|parent|document)\.)?location(?:\.href)?\s*=\s*["'`]([^"'`\s<>]+)["'`]|\blocation\.(?:replace|assign)\s*\(\s*["'`]([^"'`\s<>]+)["'`]/gi;

/**
 * Pesos por patrón: definen el orden de preferencia de los candidatos.
 * `typed` marca los patrones cuya URL no necesita terminar en ".m3u8".
 */
const PATTERN_SCORES = [
  { re: KEYED_M3U8_RE, score: 100 },
  { re: RELATIVE_KEYED_M3U8_RE, score: 80 },
  { re: TYPED_URL_BEFORE_RE, score: 70, typed: true },
  { re: TYPED_URL_AFTER_RE, score: 70, typed: true },
  { re: QUOTED_M3U8_RE, score: 60 },
  { re: QUERY_HLS_RE, score: 40 },
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

/** Evita filtrar claves view_key y tokens en cabeceras de diagnóstico o logs. */
function redactSecrets(value) {
  return String(value ?? '').replace(
    /([?&](?:view_key|api_key|access_token|token|key|signature|sig|auth)=)[^&#\s"'<>]*/gi,
    '$1[redacted]',
  );
}

function safeDiagnostic(value, maxLength = 200) {
  return safeHeaderValue(redactSecrets(value)).slice(0, maxLength);
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

  // Algunos embeds serializan JSON dentro de HTML y vuelven a escapar el
  // resultado. Hasta tres pasadas cubren escapes anidados sin ejecutar JS.
  for (let pass = 0; pass < 3; pass++) {
    const before = s;
    s = s
      .replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi, (match, braced, unicode, hex) => {
        try {
          return String.fromCodePoint(Number.parseInt(braced ?? unicode ?? hex, 16));
        } catch {
          return match;
        }
      })
      .replace(/&#x([0-9a-f]{1,6});/gi, (match, hex) => {
        try {
          return String.fromCodePoint(Number.parseInt(hex, 16));
        } catch {
          return match;
        }
      })
      .replace(/&#(\d{1,7});/g, (match, decimal) => {
        try {
          return String.fromCodePoint(Number.parseInt(decimal, 10));
        } catch {
          return match;
        }
      })
      .replace(/&sol;/gi, '/')
      .replace(/&colon;/gi, ':')
      .replace(/&period;/gi, '.')
      .replace(/&quest;/gi, '?')
      .replace(/&equals;/gi, '=')
      .replace(/&num;/gi, '#')
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&lpar;/gi, '(')
      .replace(/&rpar;/gi, ')')
      .replace(/&amp;/gi, '&')
      .replace(/\\\//g, '/') // JSON: \/ → /
      .replace(/\\(["'`])/g, '$1'); // JSON escapado
    if (s === before) break;
  }

  const flat = s
    .replace(/(["'`])\s*\+\s*(["'`])/g, '') // "a" + "b"  → ab
    .replace(/\\+/g, ''); // restos de escapes

  return { clean: s, flat };
}

/** Decodifica porcentajes en una copia de texto, nunca en el URL original. */
function decodePercentText(raw, maxPasses = 2) {
  let text = String(raw ?? '');
  for (let pass = 0; pass < maxPasses; pass++) {
    const decoded = text.replace(/(?:%[0-9a-f]{2})+/gi, (sequence) => {
      try {
        return decodeURIComponent(sequence);
      } catch {
        return sequence;
      }
    });
    if (decoded === text) break;
    text = decoded;
  }
  return text;
}

/**
 * Decodifica payloads Base64 comunes en embeds (atob/data-uri/config literal).
 * No evalúa el contenido; sólo devuelve texto que parece contener una URL o
 * configuración de reproductor.
 */
function decodeBase64Payloads(raw, maxPayloads = 48) {
  const text = String(raw ?? '');
  const re = /(?:^|[^A-Za-z0-9+/_-])([A-Za-z0-9+/_-]{20,}={0,2})(?=$|[^A-Za-z0-9+/_-])/g;
  const decoded = [];
  const seen = new Set();
  let match;

  while ((match = re.exec(text)) !== null && decoded.length < maxPayloads) {
    const candidate = match[1];
    if (candidate.length > 65_536 || seen.has(candidate)) continue;
    seen.add(candidate);

    try {
      const base64 = candidate.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      const value = new TextDecoder().decode(bytes);
      if (/(?:https?:|\/\/|%3a|m3u8|hls|player|source|file)/i.test(value)) decoded.push(value);
    } catch {
      // No era Base64 válido o no era texto UTF-8: se ignora.
    }
  }

  return decoded.join('\n');
}

/** Resuelve escapes simples de un literal JS ('\'' → ', '\\' → \). */
function unescapeJsLiteral(value) {
  return String(value ?? '').replace(/\\(['"\\\/])/g, '$1');
}

/**
 * Deshace un bloque empaquetado con el packer p.a.c.k.e.r (Dean Edwards).
 * Cada token `\w+` del payload es un número en base `radix` (0-9a-zA-Z) que
 * indexa la lista de palabras; cuando la palabra está vacía se conserva el
 * token original. Es la misma transformación textual que haría el bootstrap,
 * pero sin eval.
 *
 * @param {string} payload
 * @param {number} radix
 * @param {string[]} keywords
 * @returns {string}
 */
function applyPacker(payload, radix, keywords) {
  if (!Number.isInteger(radix) || radix < 2 || radix > 62 || keywords.length === 0) return '';

  const digitValue = (code) => {
    if (code >= 48 && code <= 57) return code - 48; // 0-9
    if (code >= 97 && code <= 122) return code - 87; // a-z → 10-35
    if (code >= 65 && code <= 90) return code - 29; // A-Z → 36-61
    return -1;
  };
  const decode = (word) => {
    let n = 0;
    for (let i = 0; i < word.length; i++) {
      const d = digitValue(word.charCodeAt(i));
      if (d < 0 || d >= radix) return -1;
      n = n * radix + d;
      if (n > keywords.length) return -1;
    }
    return n;
  };

  return payload.replace(/\b\w+\b/g, (word) => {
    const index = decode(word);
    if (index < 0 || index >= keywords.length) return word;
    return keywords[index] || word;
  });
}

/**
 * Localiza y desempaqueta todos los bloques p.a.c.k.e.r de un documento,
 * incluidos los anidados (hasta `maxRounds` niveles).
 *
 * @param {string} raw
 * @param {number} maxRounds
 * @returns {string} código desempaquetado ("" si no había bloques)
 */
export function unpackPackedJs(raw, maxRounds = 3) {
  let current = String(raw ?? '');
  const output = [];

  const unpackAll = (text) => {
    const pieces = [];
    PACKED_JS_RE.lastIndex = 0;
    let m;
    while ((m = PACKED_JS_RE.exec(text)) !== null) {
      if (PACKED_JS_RE.lastIndex === m.index) PACKED_JS_RE.lastIndex++;
      const payload = unescapeJsLiteral(m[2]);
      const radix = Number.parseInt(m[3], 10);
      const keywords = unescapeJsLiteral(m[6]).split('|');
      const unpacked = applyPacker(payload, radix, keywords);
      if (unpacked && unpacked !== payload) pieces.push(unpacked);
    }
    return pieces;
  };

  for (let round = 0; round < maxRounds; round++) {
    let pieces = unpackAll(current);
    // Un bloque anidado puede venir dentro de un literal (document.write('eval(…\'…\')')).
    if (pieces.length === 0 && round > 0) pieces = unpackAll(unescapeJsLiteral(current));
    if (pieces.length === 0) break;
    current = pieces.join('\n');
    output.push(current);
  }

  return output.join('\n');
}

/** Devuelve el documento invertido si contiene un ".m3u8" escrito al revés. */
function reverseIfObfuscated(text) {
  const s = String(text ?? '');
  if (!REVERSED_M3U8_MARK.test(s)) return '';
  return Array.from(s).reverse().join('');
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

  // Elimina puntuación sobrante pegada al final de la URL. Un ")" final se
  // conserva si cierra un "(" de la propia URL (Azure: manifest(format=m3u8-aapl)).
  u = u.replace(/^[)\]}'"`<]+/, '');
  const trimmed = u.replace(/[.,;:)\]}'"`<]+$/, '');
  const opens = (trimmed.match(/\(/g) ?? []).length;
  const closes = (trimmed.match(/\)/g) ?? []).length;
  u = opens > closes && u.charAt(trimmed.length) === ')' ? `${trimmed})` : trimmed;
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

/**
 * Comprueba que una URL HTTP(S) apunte a un playlist HLS.
 * Acepta la extensión clásica (.m3u8/.m3u), rutas con ".m3u8/" intermedio,
 * el formato de Azure Media Services "manifest(format=m3u8-aapl)" y queries
 * que seleccionan HLS (?format=m3u8, ?type=hls, ?file=…m3u8).
 */
export function isHlsUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

    let pathname = url.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // Un path parcialmente codificado sigue siendo evaluable sin decodificar.
    }
    pathname = pathname.toLowerCase();
    if (/\.m3u8?$/.test(pathname)) return true;
    if (pathname.includes('.m3u8/') || pathname.includes('(format=m3u8')) return true;

    const query = url.search.toLowerCase();
    if (!query) return false;
    // Si la query transporta otra URL (player?source=https://…m3u8) esto es un
    // envoltorio, no la playlist: la URL interna se extrae por separado.
    if (/(?:https?:|%3a%2f%2f|\/\/)/.test(query)) return false;
    if (query.includes('m3u8')) return true;
    return /[?&](?:format|type|output|protocol)=hls(?:$|&)/.test(query);
  } catch {
    return false;
  }
}

/** Compatibilidad: nombre histórico de la comprobación por extensión. */
const isM3u8Url = isHlsUrl;

/** Puntúa un candidato para ordenar los resultados de mayor a menor confianza. */
function rankUrl(url, baseScore, sourceHost) {
  let score = baseScore;
  try {
    const u = new URL(url);
    const pathname = u.pathname.toLowerCase();
    // Un CDN distinto del host del embed suele ser el stream real.
    if (u.hostname !== sourceHost) score += 5;
    // Nombres típicos de playlist maestra.
    if (/master|index|playlist|chunklist|manifest/i.test(pathname)) score += 3;
    // La extensión explícita es más fiable que una fuente deducida por `type`.
    if (/\.m3u8$/.test(pathname)) score += 2;
    // Señales de URL firmada: algunas CDNs concatenan el nombre del parámetro.
    if ([...u.searchParams.keys()].some((key) => /token|sign|signature|hash|expire|auth|policy|hdntl|key/i.test(key))) {
      score += 2;
    }
    // Avances, anuncios y muestras no son la película.
    if (/(?:^|[\/._-])(?:preview|trailer|teaser|sample|ads?|advert\w*|promo|intro|bumper)(?:$|[\/._-])/i.test(pathname)) {
      score -= 25;
    }
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
  const requestedMax = Number(opts.max);
  const max = Number.isInteger(requestedMax) && requestedMax > 0
    ? requestedMax
    : LIMITS.defaultMaxStreams * 4;
  let sourceHost = '';
  try {
    sourceHost = new URL(baseUrl).hostname;
  } catch {
    /* baseUrl inválida: seguimos, sólo afecta al ranking */
  }

  const { clean, flat } = normalizeSource(rawHtml);
  const percentText = decodePercentText(clean);
  const percent = normalizeSource(percentText);
  // Código p.a.c.k.e.r: el .m3u8 suele vivir dentro del payload empaquetado.
  const unpacked = normalizeSource(unpackPackedJs(`${clean}\n${percent.clean}`));
  const unpackedPercent = normalizeSource(decodePercentText(unpacked.clean));
  const firstBase64 = decodeBase64Payloads(`${clean}\n${percent.clean}\n${flat}\n${unpacked.clean}`);
  const secondBase64 = decodeBase64Payloads(firstBase64, 24);
  const encoded = normalizeSource(decodePercentText(`${firstBase64}\n${secondBase64}`));
  // Cadenas invertidas ("8u3m.retsam/…"): sólo si hay indicios, es costoso.
  const reversed = normalizeSource(reverseIfObfuscated(`${clean}\n${unpacked.clean}\n${encoded.clean}`));
  const candidates = new Map(); // url → score

  const add = (rawUrl, baseScore, typed = false) => {
    const abs = absolutize(rawUrl, baseUrl);
    if (!abs) return;
    if (!typed && !isHlsUrl(abs)) return;
    const score = rankUrl(abs, baseScore, sourceHost);
    // Nos quedamos siempre con la mejor puntuación de cada URL.
    if (!candidates.has(abs) || candidates.get(abs) < score) candidates.set(abs, score);
  };

  // clean y variantes decodificadas preservan la estructura del documento.
  // No se ejecuta JavaScript ni se realiza una petición a estas URLs aquí.
  const variants = [
    { text: clean, bonus: 12 },
    { text: flat, bonus: 2 },
    { text: percent.clean, bonus: 7 },
    { text: percent.flat, bonus: 0 },
    { text: unpacked.clean, bonus: 10 },
    { text: unpacked.flat, bonus: 1 },
    { text: unpackedPercent.clean, bonus: 6 },
    { text: unpackedPercent.flat, bonus: -1 },
    { text: encoded.clean, bonus: 4 },
    { text: encoded.flat, bonus: -2 },
    { text: reversed.clean, bonus: 3 },
    { text: reversed.flat, bonus: -3 },
  ];
  const seenVariants = new Set();

  for (const { text, bonus } of variants) {
    if (!text || seenVariants.has(text)) continue;
    seenVariants.add(text);
    for (const { re, score, typed } of PATTERN_SCORES) {
      re.lastIndex = 0; // las regex son /g: reseteamos el cursor
      let m;
      while ((m = re.exec(text)) !== null) {
        const captured = m[1] ?? m[0];
        add(captured, score + bonus, Boolean(typed));
        if (re.lastIndex === m.index) re.lastIndex++; // evita bucles infinitos
      }
    }
  }

  // --- Recombinación: base + fragmento de archivo/query --------------------
  // El reproductor puede construir la URL como variables separadas, por
  // ejemplo base + "master.m3u8" + "?token=...".
  if (candidates.size === 0) {
    const texts = [...seenVariants];
    const bases = [...new Set(texts.flatMap((text) => collectBasePrefixes(text)))];
    const fragments = [...new Set(texts.flatMap((text) => collectRelativeFragments(text)))];
    for (const fragment of fragments) {
      for (const base of bases) add(base + fragment, 45);
    }
  }

  return [...candidates.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, max)
    .map(([url]) => url);
}

/** Rechaza destinos locales/IP privados al seguir referencias descubiertas. */
function isSafeScanTarget(target, baseUrl) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return false;
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  if (target.username || target.password) return false;
  // El origen configurado puede ser localhost en el harness de desarrollo.
  if (target.origin === base.origin) return true;
  if (target.port) return false;

  const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === 'metadata.google.internal'
  ) return false;

  // No hacemos solicitudes a IPs literales externas; los hosts de CDNs/players
  // públicos usan nombres DNS y así evitamos SSRF a rangos internos.
  if (hostname.includes(':')) return false; // IPv6 literal
  const octets = hostname.split('.').map((part) => Number(part));
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = octets;
    if (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    ) return false;
  }

  return true;
}

/**
 * Busca URLs de configuración/API en el HTML (para el deep scan).
 *
 * @param {string} rawHtml
 * @param {string} baseUrl
 * @returns {string[]}
 */
export function findConfigUrls(rawHtml, baseUrl, opts = {}) {
  const max = Number.isInteger(Number(opts.max)) && Number(opts.max) > 0
    ? Number(opts.max)
    : LIMITS.maxConfigUrls;
  const { clean, flat } = normalizeSource(rawHtml);
  const percent = normalizeSource(decodePercentText(clean));
  const unpacked = normalizeSource(unpackPackedJs(`${clean}\n${percent.clean}`));
  const decodedBase64 = normalizeSource(
    decodePercentText(decodeBase64Payloads(`${clean}\n${percent.clean}\n${unpacked.clean}`)),
  );
  const texts = [
    ...new Set([clean, flat, percent.clean, percent.flat, unpacked.clean, unpacked.flat, decodedBase64.clean, decodedBase64.flat]),
  ].filter(Boolean);
  const candidates = new Map();
  let order = 0;

  const add = (rawUrl, context = '') => {
    const abs = absolutize(rawUrl, baseUrl);
    if (!abs) return;

    let parsed;
    try {
      parsed = new URL(abs);
    } catch {
      return;
    }
    if (!isSafeScanTarget(parsed, baseUrl)) return;

    let pathname = parsed.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      /* conservamos el path si el escape está incompleto */
    }
    const pathAndQuery = `${pathname} ${parsed.search}`.toLowerCase();
    const contextText = String(context).toLowerCase();
    const pathHints = /(?:\/|^)(?:api|ajax|embed|player|watch|video|source|stream|hls|config|media|manifest|playlist|file|load|fetch)(?:\/|$|[._-])/i.test(pathAndQuery);
    const endpointExtension = /\.(?:json|php|aspx?|do|txt|xml|m3u8)(?:$|\?)/i.test(`${pathname}${parsed.search}`);
    const isIframe = /<(?:iframe|frame)\b/i.test(contextText);
    const isMediaTag = /<(?:source|video|embed|object)\b/i.test(contextText);
    const isRedirect = /^@redirect\b|http-equiv|\blocation\b/i.test(contextText);
    const isRequestCall = /\b(?:fetch|xmlhttprequest|axios|\.get\s*\(|\.post\s*\()/i.test(contextText);
    const extension = pathname.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase() ?? '';
    const staticAsset = /^(?:css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp4|m4v|webm|ts|m4s|mp3|aac)$/i.test(extension);
    const relevantScript = extension === 'js' && /player|embed|source|hls|stream|video|config|media/i.test(pathAndQuery);

    // No descargamos imágenes, estilos, fuentes, ni segmentos multimedia. Un
    // JS sólo se sigue cuando su nombre indica que contiene el reproductor.
    if (staticAsset || (extension === 'js' && !relevantScript)) return;
    if (parsed.pathname === '/' && !pathHints && !endpointExtension && !isRedirect) return;
    if (!pathHints && !endpointExtension && !isIframe && !isMediaTag && !isRequestCall && !relevantScript && !isRedirect) return;

    let score = 0;
    if (pathHints) score += 35;
    if (endpointExtension) score += 25;
    if (isIframe) score += 30;
    if (isMediaTag) score += 20;
    if (isRequestCall) score += 25;
    if (relevantScript) score += 15;
    // Una redirección estática es, casi siempre, la página real del player.
    if (isRedirect) score += 40;
    try {
      if (new URL(baseUrl).hostname === parsed.hostname) score += 5;
    } catch {
      /* no-op */
    }

    const previous = candidates.get(parsed.toString());
    if (!previous || score > previous.score) candidates.set(parsed.toString(), { score, order: order++ });
    if (candidates.size > max * 3) {
      const weakest = [...candidates.entries()].sort((a, b) => a[1].score - b[1].score)[0];
      if (weakest) candidates.delete(weakest[0]);
    }
  };

  for (const text of texts) {
    // Redirecciones estáticas: <meta http-equiv="refresh"> y location.href = "…".
    META_REFRESH_RE.lastIndex = 0;
    let refreshMatch;
    while ((refreshMatch = META_REFRESH_RE.exec(text)) !== null) {
      add(refreshMatch[1], `@redirect ${refreshMatch[0]}`);
      if (META_REFRESH_RE.lastIndex === refreshMatch.index) META_REFRESH_RE.lastIndex++;
    }
    LOCATION_REDIRECT_RE.lastIndex = 0;
    let locationMatch;
    while ((locationMatch = LOCATION_REDIRECT_RE.exec(text)) !== null) {
      add(locationMatch[1] ?? locationMatch[2], `@redirect ${locationMatch[0]}`);
      if (LOCATION_REDIRECT_RE.lastIndex === locationMatch.index) LOCATION_REDIRECT_RE.lastIndex++;
    }

    TAG_URL_RE.lastIndex = 0;
    let tagMatch;
    while ((tagMatch = TAG_URL_RE.exec(text)) !== null) {
      add(tagMatch[2], tagMatch[0]);
      if (TAG_URL_RE.lastIndex === tagMatch.index) TAG_URL_RE.lastIndex++;
    }

    CONFIG_URL_RE.lastIndex = 0;
    let urlMatch;
    while ((urlMatch = CONFIG_URL_RE.exec(text)) !== null) {
      const context = text.slice(Math.max(0, urlMatch.index - 100), Math.min(text.length, CONFIG_URL_RE.lastIndex + 100));
      add(urlMatch[1], context);
      if (CONFIG_URL_RE.lastIndex === urlMatch.index) CONFIG_URL_RE.lastIndex++;
    }
  }

  return [...candidates.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[1].order - b[1].order)
    .slice(0, max)
    .map(([url]) => url);
}

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
    const error = new Error(`HTTP ${response.status} ${response.statusText} en ${redactSecrets(url)}`);
    error.status = response.status;
    error.url = url;
    // Un fragmento del cuerpo permite distinguir "view_key is required" de
    // otros 400 sin exponer nada sensible (se redacta y se acota).
    try {
      error.body = redactSecrets((await response.text()).slice(0, 512));
    } catch {
      error.body = '';
    }
    throw error;
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
  const source = resolveVimeusSource(env);
  const withCatalogs = Boolean(source.apiKey);
  return {
    id: ADDON.id,
    version: ADDON.version,
    name: ADDON.name,
    description: ADDON.description,
    logo: `${source.origin}/favicon.ico`,
    background: `${source.origin}/assets/images/background.jpg`,
    resources: withCatalogs ? [...ADDON.resources, 'catalog'] : [...ADDON.resources],
    types: [...ADDON.types],
    idPrefixes: [...ADDON.idPrefixes],
    catalogs: withCatalogs
      ? CATALOGS.map((catalog) => ({
          id: catalog.id,
          type: catalog.type,
          name: catalog.name,
          extra: [{ name: 'skip', isRequired: false }],
        }))
      : [],
    behaviorHints: { configurable: false, configurationRequired: false },
  };
}

/**
 * Convierte un elemento de la API de listado en un `meta` de Stremio.
 * Se prefiere el id IMDb (`tt…`) porque Cinemeta completa la ficha; si falta,
 * se usa `tmdb:ID`, que el addon también acepta en /stream.
 *
 * @param {object} item elemento de data.movies|series|animes
 * @param {string} type 'movie' | 'series'
 * @returns {object|null}
 */
export function listingItemToMeta(item, type) {
  const imdb = String(item?.imdb_id ?? '').trim();
  const tmdb = Number.parseInt(item?.tmdb_id, 10);
  const id = /^tt\d+$/i.test(imdb) ? imdb.toLowerCase() : Number.isInteger(tmdb) && tmdb > 0 ? `tmdb:${tmdb}` : '';
  if (!id) return null;

  const image = (path, size) => {
    const value = String(path ?? '').trim();
    if (!value) return undefined;
    if (/^https?:\/\//i.test(value)) return value;
    return `${TMDB_IMAGE_BASE}/${size}${value.startsWith('/') ? '' : '/'}${value}`;
  };

  const meta = {
    id,
    type,
    name: String(item?.title ?? '').trim() || id,
    poster: image(item?.poster, 'w500'),
    background: image(item?.backdrop, 'w1280'),
    posterShape: 'poster',
  };
  if (item?.content_type === 'anime') meta.genres = ['Anime'];
  if (!meta.poster) delete meta.poster;
  if (!meta.background) delete meta.background;
  return meta;
}

/** Traduce el `skip` de Stremio a la página (1-based, 50 por página) de Vimeus. */
export function listingPageFromSkip(rawSkip) {
  const skip = Number.parseInt(rawSkip, 10);
  if (!Number.isInteger(skip) || skip <= 0) return 1;
  return Math.floor(skip / LISTING_PAGE_SIZE) + 1;
}

/** Analiza `extra` de la ruta de catálogo ("skip=50&genre=x") de forma tolerante. */
function parseCatalogExtra(raw) {
  const extra = {};
  const text = String(raw ?? '').replace(/\.json$/i, '');
  if (!text) return extra;
  for (const pair of text.split('&')) {
    const [key, ...rest] = pair.split('=');
    if (!key) continue;
    try {
      extra[decodeURIComponent(key)] = decodeURIComponent(rest.join('='));
    } catch {
      extra[key] = rest.join('=');
    }
  }
  return extra;
}

/**
 * `/catalog/{type}/{id}[/skip=N].json` → metas desde la API de listado.
 * Sin VIMEUS_API_KEY o con un catálogo desconocido responde `{metas: []}`.
 */
async function handleCatalog(type, catalogId, extraRaw, env) {
  const source = resolveVimeusSource(env);
  const catalog = CATALOGS.find((c) => c.id === catalogId && c.type === type);
  if (!catalog) return jsonResponse({ metas: [] }, 404, { 'X-Proxy-Error': 'unknown-catalog' });
  if (!source.apiKey) return jsonResponse({ metas: [] }, 200, { 'X-Proxy-Error': 'missing-api-key' });

  const extra = parseCatalogExtra(extraRaw);
  const page = listingPageFromSkip(extra.skip);
  const listingUrl = `${source.origin}/api/listing/${catalog.listing}?page=${page}`;

  try {
    const response = await fetch(listingUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-API-Key': source.apiKey,
        'User-Agent': BROWSER_UA,
      },
      signal: AbortSignal.timeout(LIMITS.fetchTimeoutMs),
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (response.status === 401) {
      return jsonResponse({ metas: [] }, 200, {
        'X-Proxy-Error': 'invalid-api-key',
        'X-Proxy-Detail': safeDiagnostic(payload?.message || 'API key rechazada'),
      });
    }
    // Página fuera de rango: Vimeus responde 404 "No content found" → fin del scroll.
    if (response.status === 404) {
      return jsonResponse({ metas: [] }, 200, { 'Cache-Control': 'public, max-age=300' });
    }
    if (!response.ok || payload?.error) {
      return jsonResponse({ metas: [] }, 200, {
        'X-Proxy-Error': 'upstream',
        'X-Proxy-Detail': safeDiagnostic(payload?.message || `HTTP ${response.status}`),
      });
    }

    const items = Array.isArray(payload?.data?.[catalog.field]) ? payload.data[catalog.field] : [];
    const seen = new Set();
    const metas = [];
    for (const item of items) {
      const meta = listingItemToMeta(item, catalog.type);
      if (!meta || seen.has(meta.id)) continue;
      seen.add(meta.id);
      metas.push(meta);
    }

    return jsonResponse({ metas }, 200, {
      'Cache-Control': 'public, max-age=300',
      'X-Listing-Page': String(page),
      'X-Listing-Total-Pages': String(payload?.data?.pagination?.total_pages ?? ''),
    });
  } catch (err) {
    console.warn(`[${source.key}] catálogo ${catalog.id} falló: ${safeDiagnostic(err?.message)}`);
    return jsonResponse({ metas: [] }, 200, {
      'X-Proxy-Error': 'upstream',
      'X-Proxy-Detail': safeDiagnostic(err?.message),
    });
  }
}

/**
 * Construye el objeto `stream` que consume Stremio.
 *
 * @param {string} m3u8Url URL absoluta del .m3u8
 * @param {number} index   posición del candidato (0 = principal)
 * @param {URL} workerUrl URL del propio Worker (para el modo proxy)
 * @param {object} env    variables de entorno
 * @param {object} source proveedor (cabeceras y nombre)
 * @param {{quality?: string, live?: boolean}} [meta] datos de la playlist verificada
 * @returns {object}
 */
function buildStream(m3u8Url, index, workerUrl, env, source, meta = {}) {
  const useProxy = envFlag(env?.PROXY_HLS, false);
  const notWebReady = useProxy ? false : envFlag(env?.NOT_WEB_READY, true);
  const referer = meta?.referer || source.referer;
  const origin = meta?.origin || source.origin;

  // En modo proxy el Worker necesita saber qué Referer espera el CDN del HLS;
  // sólo se añade `ref` cuando difiere del proveedor (host de terceros).
  const proxyUrl = new URL('/proxy', workerUrl.origin);
  proxyUrl.searchParams.set('url', m3u8Url);
  if (origin !== source.origin) proxyUrl.searchParams.set('ref', origin);
  const finalUrl = useProxy ? proxyUrl.toString() : m3u8Url;

  const tags = ['HLS'];
  if (meta?.quality) tags.push(meta.quality);
  if (meta?.live) tags.push('LIVE');
  if (index > 0) tags.push(`Alt ${index + 1}`);
  const title = `${source.name} [${tags.join(' · ')}]`;

  return {
    name: ADDON.name,
    title,
    type: 'hls',
    url: finalUrl,
    behaviorHints: {
      notSupported: false,
      notWebReady,
      requestHeaders: {
        Referer: referer,
        'User-Agent': BROWSER_UA,
      },
      proxyHeaders: {
        request: {
          Referer: referer,
          'User-Agent': BROWSER_UA,
          Origin: origin,
        },
      },
      bingeGroup: `${source.key}-${index}`,
    },
  };
}

// ---------------------------------------------------------------------------
// 6. Endpoint /stream — scraping + extracción del .m3u8
// ---------------------------------------------------------------------------

/** Limpia el id de un stream y separa temporada/episodio en series. */
function parseStreamRequest(rawId, type = 'movie') {
  let raw = String(rawId ?? '').split('?')[0].split('#')[0];
  try {
    raw = decodeURIComponent(raw).trim();
  } catch {
    raw = raw.replace(/%[0-9a-f]{0,2}/gi, '').trim();
  }
  raw = raw.replace(/\.json$/i, '');

  if (type === 'series' || type === 'tv') {
    const match = raw.match(/^(.*?)(?::|\/)(\d+)(?::|\/)(\d+)$/);
    if (!match) return { id: '', season: null, episode: null };
    const id = cleanId(match[1]);
    const season = Number.parseInt(match[2], 10);
    const episode = Number.parseInt(match[3], 10);
    if (!id || !Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1) {
      return { id: '', season: null, episode: null };
    }
    return { id, season, episode };
  }

  return { id: cleanId(raw), season: null, episode: null };
}

function responsePlaylistUrl(result, requestedUrl) {
  const finalUrl = result?.response?.url || requestedUrl;
  const contentType = (result?.response?.headers?.get('Content-Type') ?? '').toLowerCase();
  const looksLikePlaylist =
    isM3u8Url(finalUrl) ||
    contentType.includes('mpegurl') ||
    contentType.includes('m3u8') ||
    String(result?.body ?? '').trimStart().startsWith('#EXTM3U');
  if (!looksLikePlaylist) return null;

  const absolute = absolutize(finalUrl, requestedUrl);
  return absolute && (isM3u8Url(absolute) || contentType.includes('mpegurl') || contentType.includes('m3u8') || String(result?.body ?? '').trimStart().startsWith('#EXTM3U'))
    ? absolute
    : null;
}

/** Clasifica el error HTTP del embed de Vimeus en un código estable. */
function classifyEmbedError(error) {
  const status = Number(error?.status);
  const body = String(error?.body ?? '').toLowerCase();
  if (status === 400 && body.includes('view_key')) return 'invalid-view-key';
  if (status === 401 || status === 403) return 'invalid-view-key';
  if (status === 404) return 'not-found';
  return status ? `http-${status}` : error?.code || 'upstream-error';
}

/**
 * Analiza una página (embed o subdocumento) y devuelve candidatos HLS con la
 * URL de la página donde aparecieron (necesaria para el Referer de reproducción).
 */
function collectCandidates(page, pageUrl, maxStreams) {
  let urls = extractM3u8Urls(page.body, pageUrl, { max: maxStreams * 4 });
  if (urls.length === 0) {
    const directPlaylist = responsePlaylistUrl(page, pageUrl);
    if (directPlaylist) urls = [directPlaylist];
  }
  return urls.map((url) => ({ url, pageUrl }));
}

/**
 * Resuelve los candidatos HLS de un título.
 *
 * Flujo (Vimeus es un agregador de embeds de terceros):
 *   1. Se piden en paralelo todas las rutas de embed (/e/serie y /e/anime son
 *      catálogos disjuntos: una responde 404 de inmediato).
 *   2. En cada página se buscan playlists; si no hay, el deep scan sigue
 *      iframes/API hasta el host de terceros que realmente sirve el HLS.
 *   3. Los candidatos se verifican con el Referer de la página donde se
 *      encontraron y se etiquetan con su calidad.
 *
 * @param {object} source
 * @param {string} kind 'movie' | 'series'
 * @param {{id:string, season:number|null, episode:number|null}} coordinates
 * @param {URL} workerUrl
 * @param {object} env
 * @param {number} maxStreams
 * @param {Array|null} [trace] si se pasa, recibe los pasos (para /debug)
 * @returns {Promise<{urls: string[], meta: Map<string, object>, error: Error|null, code: string|null}>}
 */
async function resolveProviderUrls(source, kind, coordinates, workerUrl, env, maxStreams, trace = null) {
  const embedUrls = source.embedUrlsFor(kind, coordinates.id, coordinates.season, coordinates.episode);
  const deepScanEnabled = envFlag(env?.DEEP_SCAN, true);
  let deepScanBudget = envInt(env?.MAX_DEEP_SCAN, LIMITS.maxDeepScanRequests);
  const concurrency = LIMITS.deepScanConcurrency;

  const isWorkerUrl = (target) => {
    try {
      return new URL(target).origin === workerUrl.origin;
    } catch {
      return true;
    }
  };
  const record = (entry) => {
    if (trace) trace.push(entry);
  };

  // 1. Embeds en paralelo.
  const settled = await Promise.allSettled(
    embedUrls.map((embedUrl) => fetchText(embedUrl, scrapeHeaders(source))),
  );

  const codes = [];
  let lastError = null;

  for (let i = 0; i < settled.length; i++) {
    const embedUrl = embedUrls[i];
    const outcome = settled[i];

    if (outcome.status === 'rejected') {
      const error = outcome.reason;
      const code = classifyEmbedError(error);
      codes.push(code);
      lastError = error;
      record({ step: 'embed', url: redactSecrets(embedUrl), status: error?.status ?? null, code });
      continue;
    }

    const firstPage = outcome.value;
    const firstPageUrl = firstPage.response.url || embedUrl;
    let candidates = collectCandidates(firstPage, firstPageUrl, maxStreams);
    const firstConfigUrls = candidates.length === 0 ? findConfigUrls(firstPage.body, firstPageUrl) : [];
    record({
      step: 'embed',
      url: redactSecrets(embedUrl),
      finalUrl: redactSecrets(firstPageUrl),
      status: firstPage.response.status,
      bytes: firstPage.body.length,
      candidates: candidates.map((c) => redactSecrets(c.url)),
      configUrls: firstConfigUrls.map(redactSecrets),
      html: trace?.withHtml ? redactSecrets(firstPage.body.slice(0, LIMITS.debugHtmlChars)) : undefined,
    });

    // 2. Deep scan: cola priorizada, en pequeños lotes concurrentes.
    if (candidates.length === 0 && deepScanEnabled && deepScanBudget > 0) {
      const queue = firstConfigUrls
        .filter((target) => !isWorkerUrl(target))
        .map((url) => ({ url, referer: firstPageUrl }));
      const visited = new Set([embedUrl, firstPageUrl]);
      const queued = new Set(queue.map((item) => item.url));

      while (queue.length > 0 && deepScanBudget > 0 && candidates.length === 0) {
        const batch = [];
        while (batch.length < concurrency && queue.length > 0 && deepScanBudget > 0) {
          const next = queue.shift();
          if (!next || visited.has(next.url)) continue;
          visited.add(next.url);
          deepScanBudget--;
          batch.push(next);
        }
        if (batch.length === 0) break;

        const results = await Promise.allSettled(
          batch.map((item) => fetchText(item.url, deepScanHeaders(source, item.url, item.referer))),
        );

        for (let j = 0; j < results.length; j++) {
          const item = batch[j];
          const result = results[j];
          if (result.status === 'rejected') {
            lastError = result.reason;
            record({ step: 'scan', url: redactSecrets(item.url), status: result.reason?.status ?? null, error: safeDiagnostic(result.reason?.message) });
            console.warn(`[${source.key}] deep-scan failed for id=${coordinates.id}: ${safeDiagnostic(result.reason?.message)}`);
            continue;
          }

          const page = result.value;
          const pageUrl = page.response.url || item.url;
          const found = collectCandidates(page, pageUrl, maxStreams);
          const related = found.length === 0 ? findConfigUrls(page.body, pageUrl) : [];
          record({
            step: 'scan',
            url: redactSecrets(item.url),
            finalUrl: redactSecrets(pageUrl),
            status: page.response.status,
            bytes: page.body.length,
            candidates: found.map((c) => redactSecrets(c.url)),
            configUrls: related.map(redactSecrets),
            html: trace?.withHtml ? redactSecrets(page.body.slice(0, LIMITS.debugHtmlChars)) : undefined,
          });

          if (found.length > 0 && candidates.length === 0) {
            candidates = found;
            continue;
          }
          for (const relatedUrl of related) {
            if (isWorkerUrl(relatedUrl) || visited.has(relatedUrl) || queued.has(relatedUrl)) continue;
            queued.add(relatedUrl);
            queue.push({ url: relatedUrl, referer: pageUrl });
          }
        }
      }
    }

    if (candidates.length === 0) {
      codes.push('no-hls');
      continue;
    }

    // 3. Verificación con el Referer de la página de origen de cada candidato.
    const checked = await verifyHlsCandidates(source, candidates, maxStreams, env);
    record({
      step: 'verify',
      verified: checked.urls.map(redactSecrets),
      error: checked.error ? safeDiagnostic(checked.error.message) : undefined,
    });
    if (checked.urls.length > 0) return { urls: checked.urls, meta: checked.meta, error: null, code: null };
    if (checked.error) lastError = checked.error;
    codes.push(checked.error?.code || 'invalid-hls');
  }

  // Código global: una clave inválida manda sobre todo; si todas las rutas
  // dieron 404 el título no está en el catálogo; si hubo páginas sin HLS, no-hls.
  let code = null;
  if (codes.includes('invalid-view-key')) code = 'invalid-view-key';
  else if (codes.length > 0 && codes.every((c) => c === 'not-found')) code = 'not-found';
  else if (codes.includes('no-hls')) code = 'no-hls';
  else code = codes.at(-1) || 'upstream-error';

  return { urls: [], meta: new Map(), error: lastError, code };
}

/**
 * Lee de una playlist la información útil para etiquetar el stream.
 * - master: resolución máxima declarada en #EXT-X-STREAM-INF → "1080p".
 * - media : nº de variantes = 0; se detecta si es un directo (#EXT-X-ENDLIST).
 *
 * @param {string} body contenido de la playlist (ya validado como #EXTM3U)
 * @returns {{quality: string, variants: number, live: boolean}}
 */
export function describePlaylist(body) {
  const text = String(body ?? '');
  let maxHeight = 0;
  let variants = 0;

  const streamInfRe = /#EXT-X-STREAM-INF:([^\r\n]*)/gi;
  let m;
  while ((m = streamInfRe.exec(text)) !== null) {
    variants++;
    const resolution = m[1].match(/RESOLUTION\s*=\s*(\d+)\s*x\s*(\d+)/i);
    if (resolution) maxHeight = Math.max(maxHeight, Number(resolution[2]));
  }

  const quality = maxHeight >= 2160
    ? '4K'
    : maxHeight > 0
      ? `${maxHeight}p`
      : '';
  const live = variants === 0 && !/#EXT-X-ENDLIST/i.test(text) && /#EXTINF/i.test(text);
  return { quality, variants, live };
}

/**
 * Pide cada playlist (en paralelo) con el Referer de la página donde apareció,
 * para detectar HLS caducado o páginas HTML disfrazadas, y aprovecha el cuerpo
 * para etiquetar la calidad. Conserva el orden de confianza de los candidatos.
 *
 * @param {object} source
 * @param {Array<{url: string, pageUrl?: string}|string>} candidates
 * @returns {Promise<{urls: string[], meta: Map<string, object>, error: Error|null}>}
 */
async function verifyHlsCandidates(source, candidates, maxStreams, env) {
  const items = candidates.map((c) => (typeof c === 'string' ? { url: c, pageUrl: '' } : c));

  if (!envFlag(env?.VERIFY_HLS, true)) {
    const meta = new Map();
    const urls = [];
    for (const item of items) {
      if (meta.has(item.url)) continue;
      urls.push(item.url);
      meta.set(item.url, { quality: '', variants: 0, live: false, ...playbackContext(source, item.pageUrl) });
    }
    return { urls, meta, error: null };
  }

  const verifyOne = async ({ url: candidate, pageUrl }) => {
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      const error = new Error('invalid-hls-url');
      error.code = 'invalid-hls-url';
      return { error };
    }

    if (!isSafeScanTarget(parsed, `${source.origin}/`)) {
      const error = new Error('unsafe-hls-url');
      error.code = 'unsafe-hls-url';
      return { error };
    }

    try {
      const result = await fetchText(candidate, {
        ...playbackHeaders(source, pageUrl),
        Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*;q=0.8',
      });
      const body = result.body.replace(/^\uFEFF/, '').trimStart();
      if (!body.startsWith('#EXTM3U')) {
        const error = new Error('La URL extraída no devolvió una playlist HLS válida');
        error.code = 'invalid-hls';
        return { error };
      }

      const finalUrl = absolutize(result.response.url || candidate, candidate);
      if (!finalUrl) {
        const error = new Error('invalid-hls-url');
        error.code = 'invalid-hls-url';
        return { error };
      }
      return { url: finalUrl, meta: { ...describePlaylist(body), ...playbackContext(source, pageUrl) } };
    } catch (error) {
      return { error };
    }
  };

  const outcomes = await Promise.all(items.slice(0, maxStreams).map(verifyOne));

  const verified = [];
  const meta = new Map();
  let lastError = null;
  for (const outcome of outcomes) {
    if (outcome.url) {
      if (!meta.has(outcome.url)) {
        verified.push(outcome.url);
        meta.set(outcome.url, outcome.meta);
      }
    } else if (outcome.error) {
      lastError = outcome.error;
    }
  }

  return { urls: verified, meta, error: verified.length > 0 ? null : lastError };
}

/**
 * `/debug/{movie|series}/{id}?token=…[&html=1]` — traza completa del scraping.
 *
 * Pensado para afinar el extractor con datos reales: lista las páginas
 * visitadas (embed, iframes, APIs), su estado HTTP, las URLs de configuración
 * descubiertas y los candidatos HLS. Con `html=1` incluye el inicio del HTML
 * de cada página (acotado). Sólo responde si DEBUG_TOKEN está configurado y
 * coincide; la view_key y los tokens se redactan en toda la salida.
 */
async function handleDebug(rawId, type, url, env) {
  const expected = String(env?.DEBUG_TOKEN || '').trim();
  const provided = String(url.searchParams.get('token') || '').trim();
  if (!expected || !provided || expected !== provided) {
    return jsonResponse({ error: 'Not Found' }, 404);
  }

  const kind = type === 'tv' ? 'series' : type;
  const coordinates = parseStreamRequest(rawId, kind);
  if (!coordinates.id) return jsonResponse({ error: 'bad-id' }, 400);

  const source = resolveVimeusSource(env);
  const payload = {
    addon: ADDON.version,
    kind,
    coordinates,
    provider: { key: source.key, origin: source.origin, referer: source.referer, viewKey: source.viewKey ? 'configured' : 'missing' },
    embeds: source.viewKey
      ? source.embedUrlsFor(kind, coordinates.id, coordinates.season, coordinates.episode).map(redactSecrets)
      : [],
    settings: {
      verifyHls: envFlag(env?.VERIFY_HLS, true),
      deepScan: envFlag(env?.DEEP_SCAN, true),
      maxDeepScan: envInt(env?.MAX_DEEP_SCAN, LIMITS.maxDeepScanRequests),
      maxStreams: envInt(env?.MAX_STREAMS, LIMITS.defaultMaxStreams),
    },
    trace: [],
    result: null,
  };

  if (!source.viewKey) {
    payload.result = { code: 'missing-view-key' };
    return jsonResponse(payload);
  }

  const trace = [];
  trace.withHtml = envFlag(url.searchParams.get('html'), false);
  const started = Date.now();
  const result = await resolveProviderUrls(
    source,
    kind,
    coordinates,
    url,
    env,
    payload.settings.maxStreams,
    trace,
  );
  payload.trace = trace;
  payload.result = {
    code: result.code,
    elapsedMs: Date.now() - started,
    error: result.error ? safeDiagnostic(result.error.message) : null,
    streams: result.urls.map((u) => ({ url: redactSecrets(u), ...(result.meta.get(u) || {}) })),
  };

  // Red de seguridad: la clave jamás sale aunque algún campo la contuviera.
  const json = JSON.stringify(payload, null, 2).split(source.viewKey).join('[redacted]');
  return new Response(json, {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS },
  });
}

/**
 * Resuelve un stream consultando Vimeus. Si falta la view_key, el origen falla
 * o no publica un HLS válido, responde {"streams": []} con diagnóstico en
 * cabeceras para no romper Stremio.
 */
async function handleStream(rawId, type, request, env) {
  const kind = type === 'tv' ? 'series' : type;
  const coordinates = parseStreamRequest(rawId, kind);
  if (!coordinates.id) {
    return jsonResponse({ streams: [] }, 200, { 'X-Proxy-Error': 'bad-id' });
  }

  const source = resolveVimeusSource(env);
  if (!source.viewKey) {
    console.warn(`[${source.key}] VIMEUS_VIEW_KEY no configurada; id=${coordinates.id}`);
    return jsonResponse({ streams: [] }, 200, {
      'X-Proxy-Error': 'missing-view-key',
      'X-Proxy-Detail': 'Configura VIMEUS_VIEW_KEY como secreto del Worker',
      'X-Source-Id': coordinates.id,
    });
  }

  const workerUrl = new URL(request.url);
  const maxStreams = envInt(env?.MAX_STREAMS, LIMITS.defaultMaxStreams);

  const result = await resolveProviderUrls(
    source,
    kind,
    coordinates,
    workerUrl,
    env,
    maxStreams,
  );

  if (result.urls.length > 0) {
    const streams = result.urls
      .slice(0, maxStreams)
      .map((url, index) => buildStream(url, index, workerUrl, env, source, result.meta?.get(url)));

    return jsonResponse({ streams }, 200, {
      'X-Source-Id': coordinates.id,
      'X-Candidates-Found': String(result.urls.length),
      'X-Stream-Provider': source.key,
    });
  }

  // Códigos estables para el cliente/consola:
  //   invalid-view-key → Vimeus rechazó la clave (400 "view_key is required", 401/403)
  //   not-found        → el título no está en el catálogo (404 en todas las rutas)
  //   no-hls           → el embed respondió pero no se encontró/validó ninguna playlist
  //   upstream         → error de red/HTTP distinto de los anteriores
  const code = result.code || 'no-hls';
  const status = Number(result.error?.status) || 0;
  let errorCode;
  if (code === 'invalid-view-key' || code === 'not-found') errorCode = code;
  else if (result.error) errorCode = 'upstream';
  else errorCode = 'not-found';

  let detail;
  if (code === 'invalid-view-key') {
    detail = `Vimeus rechazó la petición${status ? ` (HTTP ${status})` : ''}: revisa VIMEUS_VIEW_KEY y VIMEUS_REFERER`;
  } else if (code === 'not-found') {
    detail = 'Vimeus no tiene este título (404)';
  } else if (result.error) {
    detail = safeDiagnostic(
      result.error.message || (status ? `http-${status}` : result.error.code || 'upstream-error'),
    );
  } else {
    detail = code;
  }

  console.warn(`[${source.key}] sin HLS para id=${coordinates.id}; motivo=${errorCode}`);
  return jsonResponse({ streams: [] }, 200, {
    'X-Proxy-Error': errorCode,
    'X-Proxy-Detail': detail,
    'X-Source-Id': coordinates.id,
  });
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
export function rewritePlaylist(text, playlistUrl, workerOrigin, ref = '') {
  const refParam = ref ? `&ref=${encodeURIComponent(ref)}` : '';
  const proxify = (childUrl) => {
    const abs = absolutize(childUrl, playlistUrl);
    return abs ? `${workerOrigin}/proxy?url=${encodeURIComponent(abs)}${refParam}` : null;
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

/** Valida el parámetro `ref` del proxy: sólo un origen http(s) ajeno al Worker. */
function parseRefOrigin(raw, workerOrigin) {
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (parsed.origin === workerOrigin || !parsed.hostname.includes('.')) return '';
    return parsed.origin;
  } catch {
    return '';
  }
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

  // `ref` = origen de la página de embed (de terceros) donde se halló el HLS;
  // su CDN valida ese Referer. Sin `ref` se usan las cabeceras de Vimeus.
  // Se ignora un eventual `?provider=` heredado de enlaces antiguos.
  const source = resolveVimeusSource(env);
  const ref = parseRefOrigin(url.searchParams.get('ref'), url.origin);

  try {
    const headers = { ...playbackHeaders(source, ref ? `${ref}/` : ''), Accept: '*/*' };
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
      ? rewritePlaylist(text, abs.toString(), url.origin, ref)
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
    console.error(`[${source.key}] proxy falló en ${safeDiagnostic(abs.toString())}: ${safeDiagnostic(err?.message)}`);
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
 * @param {{addon:string,id:string,version:string,source:string,provider:string,vimeusConfigured:boolean,install:string}} info
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
  input,select{min-width:0;padding:.6rem .75rem;border-radius:8px;border:1px solid #30363d;
       background:#010409;color:#e6edf3;font:inherit}
  input{flex:1 1 240px}
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
      <dt>Proveedor</dt><dd><code>${info.provider}</code></dd>
      <dt>Vimeus view_key</dt><dd><code>${info.vimeusConfigured ? 'configurada' : 'no configurada; el addon no devolverá streams'}</code></dd>
      <dt>Catálogos (API Key)</dt><dd><code>${info.catalogsEnabled ? 'activos' : 'desactivados; configura VIMEUS_API_KEY'}</code></dd>
      <dt>Origen</dt><dd><code>${info.source}</code></dd>
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
      Película: <code>tt1234567</code> · Serie: <code>tt0903747:1:2</code> (id:temporada:episodio).
    </p>
    <div class="row">
      <select id="kind" aria-label="Tipo de contenido">
        <option value="movie">Película</option>
        <option value="series">Serie</option>
      </select>
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
      <li><code>GET /stream/series/{id}:{temporada}:{episodio}.json</code></li>
      <li><code>GET /catalog/{movie|series}/{vimeus-movies|vimeus-series|vimeus-animes}[/skip=N].json</code> — requiere <code>VIMEUS_API_KEY</code></li>
      <li><code>GET /proxy?url=&lt;m3u8|segmento&gt;[&amp;ref=&lt;origen&gt;]</code> — pasarela HLS</li>
      <li><code>GET /debug/{movie|series}/{id}?token=…[&amp;html=1]</code> — traza de scraping (requiere <code>DEBUG_TOKEN</code>)</li>
      <li><code>OPTIONS *</code> — preflight CORS</li>
    </ul>
  </div>
</main>
<script>
async function resolver(){
  var out = document.getElementById('out');
  var id = document.getElementById('mid').value.trim();
  var kind = document.getElementById('kind').value;
  if(!id){ out.textContent = 'Escribe un id.'; return; }
  var endpoint = '/stream/' + kind + '/' + encodeURIComponent(id) + '.json';
  out.textContent = 'Consultando ' + endpoint + ' …';
  try {
    var t0 = performance.now();
    var res = await fetch(endpoint);
    var ms = Math.round(performance.now() - t0);
    var data = await res.json();
    var n = (data.streams || []).length;
    var code = res.headers.get('X-Proxy-Error');
    var detail = res.headers.get('X-Proxy-Detail');
    var diagnostic = code ? '\nDiagnóstico: ' + code + (detail ? ' · ' + detail : '') : '';
    out.textContent = 'HTTP ' + res.status + ' · ' + ms + ' ms · ' + n + ' stream(s)' + diagnostic + '\n\n'
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

/** /stream/[movie|series|tv]/{id}[.json] (series admite id:temporada:episodio). */
const STREAM_ROUTE_RE = /^\/stream\/(?:(movie|series|tv|channel)\/)?(.+)$/i;

/** /catalog/{type}/{id}[/{extra}].json — catálogos de la API de listado. */
const CATALOG_ROUTE_RE = /^\/catalog\/(movie|series)\/([^/]+?)(?:\/([^/]+?))?(?:\.json)?$/i;

/** /debug/[movie|series|tv]/{id} — traza de scraping protegida por DEBUG_TOKEN. */
const DEBUG_ROUTE_RE = /^\/debug\/(movie|series|tv)\/(.+)$/i;

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
        const source = resolveVimeusSource(env);
        const payload = {
          status: 'ok',
          addon: ADDON.name,
          id: ADDON.id,
          version: ADDON.version,
          source: source.origin,
          provider: source.key,
          vimeusConfigured: Boolean(source.viewKey),
          catalogsEnabled: Boolean(source.apiKey),
          endpoints: [
            '/manifest.json',
            '/stream/movie/{id}.json',
            '/stream/series/{id}:{season}:{episode}.json',
            '/catalog/{type}/{id}.json (requiere VIMEUS_API_KEY)',
            '/proxy?url=',
            '/debug/{movie|series}/{id}?token= (requiere DEBUG_TOKEN)',
          ],
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

      // --- Catálogos (API de listado; requiere VIMEUS_API_KEY) ---------------
      const catalogMatch = rawPath.match(CATALOG_ROUTE_RE);
      if (catalogMatch) {
        return await handleCatalog(
          catalogMatch[1].toLowerCase(),
          catalogMatch[2].replace(/\.json$/i, ''),
          catalogMatch[3] ?? '',
          env,
        );
      }

      // --- Streams ---------------------------------------------------------
      // Se compara sobre `rawPath` para no perder mayúsculas del id externo.
      const streamMatch = rawPath.match(STREAM_ROUTE_RE);
      if (streamMatch) {
        const type = (streamMatch[1] || 'movie').toLowerCase();
        return await handleStream(streamMatch[2], type, request, env);
      }

      // --- Pasarela HLS opcional -------------------------------------------
      if (path === '/proxy' || path === '/hls') {
        return await handleProxy(url, request, env);
      }

      // --- Traza de depuración (requiere DEBUG_TOKEN) -----------------------
      const debugMatch = rawPath.match(DEBUG_ROUTE_RE);
      if (debugMatch) {
        return await handleDebug(debugMatch[2], debugMatch[1].toLowerCase(), url, env);
      }

      // --- 404 amigable -----------------------------------------------------
      return jsonResponse(
        {
          error: 'Not Found',
          hint: 'Rutas válidas: /manifest.json, /stream/movie/{id}.json, /stream/series/{id}:{season}:{episode}.json, /catalog/{type}/{id}.json',
        },
        404,
      );
    } catch (err) {
      // Red de seguridad global: el Worker nunca debe devolver un stack trace.
      console.error(`[addon] error no controlado en ${path}: ${safeDiagnostic(err?.message)}`);
      if (path.startsWith('/stream')) return jsonResponse({ streams: [] }, 200);
      if (path.startsWith('/catalog')) return jsonResponse({ metas: [] }, 200);
      return jsonResponse({ error: 'Internal Server Error' }, 500);
    }
  },
};
