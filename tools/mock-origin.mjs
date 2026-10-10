/**
 * ============================================================================
 *  tools/mock-origin.mjs — Origen de vídeo de pega para pruebas locales
 * ============================================================================
 *
 *  Simula el embed de Vimeus + su CDN para probar el Worker de punta a punta
 *  sin tocar la red real. NO se despliega: sólo desarrollo.
 *
 *  Uso:
 *    node tools/mock-origin.mjs            # escucha en 0.0.0.0:8788
 *    PORT=9000 node tools/mock-origin.mjs
 *
 *  Rutas (todas exigen view_key=local-test-key):
 *    GET /e/movie?imdb=tt1234567&view_key=… → JWPlayer con el .m3u8 escapado
 *    GET /e/movie?imdb=tt9999999&view_key=… → deep-scan: el .m3u8 viene de /api
 *    GET /e/movie?imdb=tt0000000&view_key=… → HTML sin ningún .m3u8
 *    GET /e/movie?imdb=tt5555555&view_key=… → script ofuscado con p.a.c.k.e.r
 *    GET /e/serie|/e/anime?tmdb=…&se=&ep=   → episodios (mismo fixture JWPlayer)
 *    GET /api/source/tt9999999              → JSON con la URL del stream
 *    GET /api/listing/{movies|series|animes}?page=N → API de listado (X-API-Key: local-api-key)
 *    GET /hls/.../*.m3u8                    → playlists (exigen Referer, si no → 403)
 *    GET /hls/.../*.ts                      → segmentos de pega (exigen Referer)
 * ============================================================================
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8788);
const HOST = process.env.HOST ?? '0.0.0.0';

/** Origen público del CDN de pega: el Worker lo verá tal cual. */
const cdnBase = (req) => `http://${req.headers.host}`;

const REFERER_REQUIRED = true;

/** 403 si no viene Referer: demuestra que el Worker/proxy inyecta cabeceras. */
function checkReferer(req, res) {
  if (!REFERER_REQUIRED) return true;
  if (!req.headers.referer) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden: falta Referer');
    return false;
  }
  return true;
}

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Fixtures: tres escenarios reales de reproductor embebido
// ---------------------------------------------------------------------------

/** Escenario 1 — JWPlayer con la URL escapada como JSON ("https:\/\/…"). */
const embedJwplayer = (req) => `<!doctype html>
<html><head><title>Vimeus — embed</title></head><body>
<div id="player"></div>
<script src="/assets/jwplayer.js"></script>
<script>
  jwplayer("player").setup({
    width: "100%",
    aspectratio: "16:9",
    sources: [{
      file: "${cdnBase(req).replace(/\//g, '\\/')}\\/hls\\/tt1234567\\/master.m3u8?token=abc123",
      type: "application/x-mpegURL"
    }],
    image: "/poster/tt1234567.jpg"
  });
</script>
</body></html>`;

/** Escenario 2 — el .m3u8 NO está en el HTML: lo sirve /api/source/{id}. */
const embedDeepScan = (req) => `<!doctype html>
<html><body><div id="player"></div>
<script>
  fetch("/api/source/tt9999999", { headers: { "X-Requested-With": "XMLHttpRequest" } })
    .then(function (r) { return r.json(); })
    .then(function (cfg) { hls.loadSource(cfg.file); hls.attachMedia(video); });
</script>
</body></html>`;

const deepScanApi = (req) =>
  JSON.stringify({
    status: 200,
    file: `${cdnBase(req)}/hls/tt9999999/master.m3u8?token=deep`,
    poster: '/poster.jpg',
  });

/** Escenario 3 — página sin stream (debe producir {"streams": []}). */
const embedEmpty = () => `<!doctype html><html><body><p>Contenido no disponible</p></body></html>`;

/**
 * Escenario 4 — configuración del player ofuscada con el packer de Dean
 * Edwards (eval(function(p,a,c,k,e,d){…})). El Worker la desempaqueta como
 * texto, sin ejecutar JavaScript.
 */
function packJs(src, radix = 62) {
  const enc = (c) =>
    (c < radix ? '' : enc(Math.floor(c / radix))) +
    ((c = c % radix) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
  const words = [...new Set(src.match(/\b\w+\b/g))];
  const payload = src.replace(/\b\w+\b/g, (w) => enc(words.indexOf(w)));
  const keywords = words.map((w, i) => (enc(i) === w ? '' : w));
  const esc = (v) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return (
    "eval(function(p,a,c,k,e,d){e=function(c){return(c<a?'':e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};" +
    "if(!''.replace(/^/,String)){while(c--){d[e(c)]=k[c]||e(c)}k=[function(e){return d[e]}];e=function(){return'\\\\w+'};c=1};" +
    "while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}" +
    `('${esc(payload)}',${radix},${keywords.length},'${esc(keywords.join('|'))}'.split('|'),0,{}))`
  );
}
const embedPacked = (req) => `<!doctype html>
<html><body><div id="vplayer"></div>
<script>${packJs(`var player=jwplayer("vplayer");player.setup({sources:[{file:"${cdnBase(req)}/hls/tt5555555/master.m3u8?token=packed",type:"hls"}]});`)}</script>
</body></html>`;

/** Mock del embed Vimeus; requiere la clave de prueba local, no una clave real. */
const VIMEUS_MOCK_VIEW_KEY = 'local-test-key';
const VIMEUS_MOCK_API_KEY = 'local-api-key';

/**
 * Imita GET /api/listing/{movies|series|animes}: exige X-API-Key, pagina de
 * 50 en 50 y responde 404 "No content found" cuando la página no existe.
 * Devuelve [status, bodyJson] para `send`.
 */
function listingApi(req, url, kind) {
  const fail = (status, message) => [status, JSON.stringify({ error: true, message, data: null })];
  if (req.headers['x-api-key'] !== VIMEUS_MOCK_API_KEY) return fail(401, 'API key is required');
  const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  if (!Number.isInteger(page) || page < 1) return fail(400, 'Invalid page number');

  const catalog = {
    movies: [
      { tmdb_id: 1001, imdb_id: 'tt1234567', title: 'Película de prueba (JWPlayer)', content_type: 'movie' },
      { tmdb_id: 1002, imdb_id: 'tt9999999', title: 'Película deep-scan', content_type: 'movie' },
      { tmdb_id: 1003, imdb_id: 'tt5555555', title: 'Película p.a.c.k.e.r', content_type: 'movie' },
      { tmdb_id: 1004, imdb_id: 'tt0000000', title: 'Película sin HLS', content_type: 'movie' },
    ],
    series: [
      { tmdb_id: 1396, imdb_id: 'tt0903747', title: 'Breaking Bad', content_type: 'series', total_seasons: 5, total_episodes: 62 },
    ],
    animes: [
      { tmdb_id: 1429, imdb_id: 'tt2560140', title: 'Attack on Titan', content_type: 'anime', total_seasons: 4, total_episodes: 89 },
    ],
  }[kind];
  // Rellena hasta 50 para que el cliente pueda probar el scroll (skip=50 → page 2 → 404).
  const items = Array.from({ length: 50 }, (_, i) => {
    const base = catalog[i % catalog.length];
    return { id: i + 1, ...base, title: i < catalog.length ? base.title : `${base.title} #${i + 1}`, imdb_id: i < catalog.length ? base.imdb_id : null, tmdb_id: i < catalog.length ? base.tmdb_id : base.tmdb_id * 100 + i, poster: '/mock-poster.jpg', backdrop: '/mock-backdrop.jpg', synced_at: '2025-01-15T10:30:00Z' };
  });
  if (page > 1) return fail(404, 'No content found');
  return [200, JSON.stringify({
    error: false,
    message: 'Success',
    data: { [kind]: items, pagination: { current_page: 1, total_pages: 1, total_results: items.length, per_page: 50, has_next: false, has_prev: false } },
  })];
}
const embedVimeus = (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get('view_key') !== VIMEUS_MOCK_VIEW_KEY) {
    return send(res, 401, 'view_key de desarrollo no válida', 'text/plain; charset=utf-8');
  }

  const id = url.searchParams.get('imdb') || url.searchParams.get('tmdb');
  if (id === 'tt0000000' || id === '0') return send(res, 200, embedEmpty());
  if (id === 'tt9999999') return send(res, 200, embedDeepScan(req));
  if (id === 'tt5555555') return send(res, 200, embedPacked(req));
  return send(res, 200, embedJwplayer(req));
};

const masterPlaylist = (req, id) => `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
720p.m3u8
`;

const mediaPlaylist = (req, id) => `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="key.php?id=${id}"
#EXTINF:6.000,
seg0.ts
#EXTINF:6.000,
seg1.ts
#EXT-X-ENDLIST
`;

// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // --- Embed Vimeus -------------------------------------------------------
  if (path === '/e/movie' || path === '/e/serie' || path === '/e/anime') {
    return embedVimeus(req, res);
  }

  // --- API de listado (catálogos) ------------------------------------------
  const listing = path.match(/^\/api\/listing\/(movies|series|animes)$/);
  if (listing) {
    return send(res, ...listingApi(req, url, listing[1]), 'application/json; charset=utf-8');
  }

  // --- API usada por el deep-scan ------------------------------------------
  if (path === '/api/source/tt9999999') {
    return send(res, 200, deepScanApi(req), 'application/json; charset=utf-8');
  }

  // --- Playlists y segmentos (protegidos por Referer) -----------------------
  if (/\.m3u8$/.test(path)) {
    if (!checkReferer(req, res)) return;
    const id = path.split('/').slice(-2, -1)[0] ?? 'tt1234567';
    if (/(master|index)\.m3u8$/.test(path)) {
      return send(res, 200, masterPlaylist(req, id), 'application/vnd.apple.mpegurl');
    }
    return send(res, 200, mediaPlaylist(req, id), 'application/vnd.apple.mpegurl');
  }

  if (/\.ts$/.test(path)) {
    if (!checkReferer(req, res)) return;
    // Segmento de pega con soporte real de Range, para validar el passthrough.
    const payload = Buffer.from(
      'G'.repeat(188) + '\x47' + 'payload-de-prueba'.repeat(8),
      'utf8',
    );
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : payload.length - 1;
      const slice = payload.subarray(start, Math.min(end, payload.length - 1) + 1);
      res.writeHead(206, {
        'Content-Type': 'video/mp2t',
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${payload.length}`,
        'Content-Length': String(slice.length),
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(slice);
    }
    res.writeHead(200, {
      'Content-Type': 'video/mp2t',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(payload.length),
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(payload);
  }

  if (path.endsWith('key.php')) {
    if (!checkReferer(req, res)) return;
    return send(res, 200, 'x'.repeat(16), 'application/octet-stream');
  }

  return send(res, 404, '404 no encontrado en el origen de pega', 'text/plain; charset=utf-8');
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-origin] escuchando en http://${HOST}:${PORT}`);
  console.log(`[mock-origin] embed HLS   → http://${HOST}:${PORT}/e/movie?imdb=tt1234567&view_key=${VIMEUS_MOCK_VIEW_KEY}`);
  console.log(`[mock-origin] embed deep  → http://${HOST}:${PORT}/e/movie?imdb=tt9999999&view_key=${VIMEUS_MOCK_VIEW_KEY}`);
  console.log(`[mock-origin] embed vacío → http://${HOST}:${PORT}/e/movie?imdb=tt0000000&view_key=${VIMEUS_MOCK_VIEW_KEY}`);
  console.log(`[mock-origin] embed packed→ http://${HOST}:${PORT}/e/movie?imdb=tt5555555&view_key=${VIMEUS_MOCK_VIEW_KEY}`);
});
