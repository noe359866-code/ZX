/**
 * ============================================================================
 *  tools/mock-origin.mjs — Origen de vídeo de pega para pruebas locales
 * ============================================================================
 *
 *  Simula el embed de UnlimPlay + su CDN para poder probar el Worker de punta
 *  a punta sin tocar la red real. NO se despliega: es sólo harness de desarrollo.
 *
 *  Uso:
 *    node tools/mock-origin.mjs            # escucha en 0.0.0.0:8788
 *    PORT=9000 node tools/mock-origin.mjs
 *
 *  Rutas:
 *    GET /f/embed/movie/tt1234567   → HTML con JWPlayer y la URL escapada (\/)
 *    GET /f/embed/movie/tt9999999   → HTML con deep-scan: el .m3u8 viene de /api
 *    GET /api/source/tt9999999      → JSON con la URL del stream
 *    GET /f/embed/movie/tt0000000   → HTML sin ningún .m3u8
 *    GET /hls/.../*.m3u8            → playlists (exigen Referer, si no → 403)
 *    GET /hls/.../*.ts              → segmentos de pega (exigen Referer)
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
<html><head><title>UnlimPlay — embed</title></head><body>
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

  // --- Embeds -------------------------------------------------------------
  if (path === '/f/embed/movie/tt1234567') return send(res, 200, embedJwplayer(req));
  if (path === '/f/embed/movie/tt9999999') return send(res, 200, embedDeepScan(req));
  if (path === '/f/embed/movie/tt0000000') return send(res, 200, embedEmpty());
  if (path.startsWith('/f/embed/movie/')) return send(res, 200, embedJwplayer(req));

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
  console.log(`[mock-origin] embed OK      → http://${HOST}:${PORT}/f/embed/movie/tt1234567`);
  console.log(`[mock-origin] embed deep    → http://${HOST}:${PORT}/f/embed/movie/tt9999999`);
  console.log(`[mock-origin] embed vacío   → http://${HOST}:${PORT}/f/embed/movie/tt0000000`);
});
