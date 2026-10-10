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
 *    GET /e/serie|/e/anime?tmdb=…&se=&ep=   → episodios (mismo fixture JWPlayer)
 *    GET /api/source/tt9999999              → JSON con la URL del stream
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

/** Mock del embed Vimeus; requiere la clave de prueba local, no una clave real. */
const VIMEUS_MOCK_VIEW_KEY = 'local-test-key';
const embedVimeus = (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get('view_key') !== VIMEUS_MOCK_VIEW_KEY) {
    return send(res, 401, 'view_key de desarrollo no válida', 'text/plain; charset=utf-8');
  }

  const id = url.searchParams.get('imdb') || url.searchParams.get('tmdb');
  if (id === 'tt0000000' || id === '0') return send(res, 200, embedEmpty());
  if (id === 'tt9999999') return send(res, 200, embedDeepScan(req));
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
});
