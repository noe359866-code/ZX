/**
 * Pruebas de integración del router del Worker.
 * Se sustituye el fetch() global por un mock, así no se toca la red real.
 *
 * Ejecutar con:  npm test
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';

const WORKER_URL = 'https://unlimplay-proxy.user.workers.dev';
const EMBED_URL = 'https://unlimplay.com/f/embed/movie/tt1234567';

const realFetch = globalThis.fetch;

/**
 * Instala un fetch de mentira.
 * @param {(url: string, init?: object) => Response|Promise<Response>} handler
 */
function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    return handler(url, init);
  };
  return calls;
}

const htmlResponse = (body) =>
  new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

beforeEach(() => {
  globalThis.fetch = realFetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Helper para invocar el Worker. */
const call = (path, init = {}) => worker.fetch(new Request(`${WORKER_URL}${path}`, init), {}, {});

// ---------------------------------------------------------------------------
// CORS y rutas básicas
// ---------------------------------------------------------------------------
test('OPTIONS: responde 204 con cabeceras CORS', async () => {
  const res = await call('/manifest.json', { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.match(res.headers.get('Access-Control-Allow-Methods'), /GET/);
  assert.match(res.headers.get('Access-Control-Expose-Headers'), /X-Proxy-Detail/);
});

test('todas las respuestas GET llevan Access-Control-Allow-Origin: *', async () => {
  mockFetch(() => htmlResponse('<html></html>'));
  for (const path of ['/', '/manifest.json', '/stream/movie/tt1.json', '/no-existe']) {
    const res = await call(path);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*', `CORS ausente en ${path}`);
  }
});

test('POST: 405 Method Not Allowed', async () => {
  const res = await call('/manifest.json', { method: 'POST' });
  assert.equal(res.status, 405);
});

test('ruta desconocida: 404 con pista', async () => {
  const res = await call('/foo/bar');
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.ok(body.hint);
});

test('raíz: healthcheck con la URL de instalación', async () => {
  const res = await call('/');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.install, `${WORKER_URL}/manifest.json`);
});

// ---------------------------------------------------------------------------
// /manifest.json
// ---------------------------------------------------------------------------
test('GET /manifest.json: contrato exacto de Stremio', async () => {
  const res = await call('/manifest.json');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /application\/json/);

  const m = await res.json();
  assert.equal(m.id, 'com.cf.unlimplay.proxy');
  assert.equal(m.name, 'UnlimPlay Proxy Stream');
  assert.deepEqual(m.resources, ['stream']);
  assert.deepEqual(m.types, ['movie', 'series']);
  assert.deepEqual(m.idPrefixes, ['tt', 'tmdb:']);
});

// ---------------------------------------------------------------------------
// /stream/movie/{id}.json
// ---------------------------------------------------------------------------
const EMBED_HTML = `<!doctype html><html><body><script>
  jwplayer("player").setup({
    sources: [{
      file: "https:\\/\\/cdn.unlimplay.com\\/hls\\/tt1234567\\/master.m3u8?token=abc123",
      type: "application/x-mpegURL"
    }]
  });
</script></body></html>`;

test('GET /stream/movie/{id}.json: URL pedida al embed y respuesta Stremio', async () => {
  const calls = mockFetch((url) => {
    assert.equal(url, EMBED_URL, 'debe consultar https://unlimplay.com/f/embed/movie/{id}');
    return htmlResponse(EMBED_HTML);
  });

  const res = await call('/stream/movie/tt1234567.json');
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.streams.length, 1);

  const stream = body.streams[0];
  assert.equal(stream.title, 'UnlimPlay 1080p [HLS Edge]');
  assert.equal(stream.type, 'hls');
  assert.equal(stream.url, 'https://cdn.unlimplay.com/hls/tt1234567/master.m3u8?token=abc123');

  assert.equal(stream.behaviorHints.notSupported, false);
  assert.equal(stream.behaviorHints.requestHeaders.Referer, 'https://unlimplay.com/');
  assert.match(stream.behaviorHints.requestHeaders['User-Agent'], /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\)/);

  // Cabeceras de navegador moderno en la petición de scraping.
  assert.equal(calls.length, 1);
  assert.match(calls[0].init.headers['User-Agent'], /Chrome\/\d+.*Safari\/537\.36/);
  assert.equal(calls[0].init.headers.Referer, 'https://unlimplay.com/');
});

test('el id se limpia: tmdb:movie:550.json → 550', async () => {
  const calls = mockFetch(() => htmlResponse(EMBED_HTML));
  const res = await call('/stream/movie/tmdb:movie:550.json');
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, 'https://unlimplay.com/f/embed/movie/550');
  const body = await res.json();
  assert.equal(body.streams.length, 1);
});

test('id inválido: devuelve streams vacío sin llamar al origen', async () => {
  const calls = mockFetch(() => htmlResponse(EMBED_HTML));
  const res = await call('/stream/movie/%20.json');
  const body = await res.json();
  assert.deepEqual(body, { streams: [] });
  assert.equal(calls.length, 0);
});

test('HTML sin .m3u8: devuelve {"streams": []}', async () => {
  mockFetch(() => htmlResponse('<html><body><p>sin vídeo</p></body></html>'));
  const res = await call('/stream/movie/tt1234567.json');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { streams: [] });
});

test('origen caído (HTTP 500): devuelve {"streams": []} sin lanzar', async () => {
  mockFetch(() => new Response('boom', { status: 500 }));
  const res = await call('/stream/movie/tt1234567.json');
  assert.equal(res.status, 200, 'nunca debe propagar el fallo a Stremio');
  const body = await res.json();
  assert.deepEqual(body.streams, []);
  assert.equal(res.headers.get('X-Proxy-Error'), 'upstream');
});

test('origen que lanza excepción de red: devuelve {"streams": []}', async () => {
  mockFetch(() => {
    throw new Error('DNS lookup failed');
  });
  const res = await call('/stream/movie/tt1234567.json');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { streams: [] });
});

test('deep scan: encuentra el .m3u8 en la API de configuración', async () => {
  const calls = mockFetch((url) => {
    if (url === EMBED_URL) {
      return htmlResponse('<script>fetch("/api/source/tt1234567").then(r=>r.json())</script>');
    }
    if (url === 'https://unlimplay.com/api/source/tt1234567') {
      return new Response(JSON.stringify({ file: 'https://cdn.unlimplay.com/x/master.m3u8?t=1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`petición inesperada: ${url}`);
  });

  const res = await call('/stream/movie/tt1234567.json');
  const body = await res.json();
  assert.equal(body.streams.length, 1);
  assert.equal(body.streams[0].url, 'https://cdn.unlimplay.com/x/master.m3u8?t=1');
  assert.equal(calls.length, 2, 'una petición al embed + una al endpoint de configuración');
});

test('deep scan sigue iframes anidados hasta la configuración HLS', async () => {
  const calls = mockFetch((url) => {
    if (url === EMBED_URL) return htmlResponse('<iframe src="/embed/player/tt1234567"></iframe>');
    if (url === 'https://unlimplay.com/embed/player/tt1234567') {
      return htmlResponse('<iframe src="/player/config.php?id=tt1234567"></iframe>');
    }
    if (url === 'https://unlimplay.com/player/config.php?id=tt1234567') {
      return new Response(JSON.stringify({ file: 'https://cdn.example.net/hls/master.m3u8?token=live' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`petición inesperada: ${url}`);
  });

  const res = await call('/stream/movie/tt1234567.json');
  const { streams } = await res.json();
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://cdn.example.net/hls/master.m3u8?token=live');
  assert.equal(calls.length, 3, 'embed + iframe + endpoint de configuración');
});

test('redirect del embed: resuelve las fuentes relativas contra la URL final', async () => {
  const calls = mockFetch((url) => {
    assert.equal(url, EMBED_URL);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'https://player.example.net/embed/page.html',
      headers: new Headers({ 'Content-Type': 'text/html; charset=utf-8' }),
      text: async () => '<video><source src="../hls/master.m3u8?token=r"></video>',
    };
  });

  const res = await call('/stream/movie/tt1234567.json');
  const { streams } = await res.json();
  assert.equal(streams[0].url, 'https://player.example.net/hls/master.m3u8?token=r');
  assert.equal(calls.length, 1);
});

test('redirect directo a un playlist: devuelve la URL final aunque el body sea M3U8', async () => {
  const playlistUrl = 'https://cdn.example.net/live/master.m3u8?signature=signed';
  mockFetch(() => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    url: playlistUrl,
    headers: new Headers({ 'Content-Type': 'application/vnd.apple.mpegurl' }),
    text: async () => '#EXTM3U\\n#EXT-X-ENDLIST',
  }));

  const res = await call('/stream/movie/tt1234567.json');
  const { streams } = await res.json();
  assert.equal(streams[0].url, playlistUrl);
});

test('series: traduce id:temporada:episodio al endpoint /f/embed/tv', async () => {
  const calls = mockFetch((url) => {
    assert.equal(url, 'https://unlimplay.com/f/embed/tv/tt0903747/1/2');
    return htmlResponse('<script>player.setup({file:"https://cdn.example.net/episode.m3u8"})</script>');
  });

  const res = await call('/stream/series/tt0903747:1:2.json');
  const { streams } = await res.json();
  assert.equal(streams.length, 1);
  assert.equal(calls.length, 1);
});

test('series: también acepta tmdb id en segmentos y rechaza episodio incompleto', async () => {
  const calls = mockFetch(() => htmlResponse('<script>player.setup({file:"https://cdn.example.net/episode.m3u8"})</script>'));
  const res = await call('/stream/tv/1396/1/1.json');
  assert.equal((await res.json()).streams.length, 1);
  assert.equal(calls[0].url, 'https://unlimplay.com/f/embed/tv/1396/1/1');

  const invalid = await call('/stream/series/tt0903747.json');
  assert.deepEqual(await invalid.json(), { streams: [] });
  assert.equal(invalid.headers.get('X-Proxy-Error'), 'bad-id');
  assert.equal(calls.length, 1, 'no consulta el origen para un episodio incompleto');
});

test('deep scan no vuelve a solicitar la URL del propio Worker', async () => {
  const calls = mockFetch((url) => {
    if (url !== EMBED_URL) throw new Error(`bucle inesperado: ${url}`);
    return htmlResponse(`<iframe src="${WORKER_URL}/stream/movie/tt1234567.json"></iframe>`);
  });

  const res = await call('/stream/movie/tt1234567.json');
  assert.deepEqual(await res.json(), { streams: [] });
  assert.equal(calls.length, 1);
});

test('deep scan conserva el diagnóstico si una página anidada devuelve 403', async () => {
  mockFetch((url) => {
    if (url === EMBED_URL) return htmlResponse('<iframe src="/player/config.php?id=x"></iframe>');
    return new Response('Acceso denegado', { status: 403, statusText: 'Forbidden' });
  });

  const res = await call('/stream/movie/tt1234567.json');
  assert.deepEqual(await res.json(), { streams: [] });
  assert.equal(res.headers.get('X-Proxy-Error'), 'upstream');
  assert.match(res.headers.get('X-Proxy-Detail'), /403/);
});

test('deep scan desactivado por env: no hace peticiones extra', async () => {
  const calls = mockFetch((url) => {
    if (url === EMBED_URL) return htmlResponse('<script>fetch("/api/source/x")</script>');
    throw new Error(`petición inesperada: ${url}`);
  });

  const res = await worker.fetch(
    new Request(`${WORKER_URL}/stream/movie/tt1234567.json`),
    { DEEP_SCAN: '0' },
    {},
  );
  assert.deepEqual(await res.json(), { streams: [] });
  assert.equal(calls.length, 1);
});

test('varios candidatos: el principal conserva el título exigido', async () => {
  mockFetch(() =>
    htmlResponse(`
      <script>player.setup({ file: "https://cdn-a.example.net/master.m3u8?token=x" });</script>
      <script>var alt = "https://cdn-b.example.net/backup.m3u8";</script>`),
  );
  const res = await call('/stream/movie/tt1234567.json');
  const { streams } = await res.json();
  assert.ok(streams.length >= 2);
  assert.equal(streams[0].title, 'UnlimPlay 1080p [HLS Edge]');
  assert.match(streams[1].title, /Alt 2/);
});

test('MAX_STREAMS limita el número de streams devueltos', async () => {
  mockFetch(() =>
    htmlResponse(`
      <script>a({file:"https://c1.example.net/1.m3u8"});</script>
      <script>b({file:"https://c2.example.net/2.m3u8"});</script>
      <script>c({file:"https://c3.example.net/3.m3u8"});</script>
      <script>d({file:"https://c4.example.net/4.m3u8"});</script>`),
  );
  const res = await worker.fetch(
    new Request(`${WORKER_URL}/stream/movie/tt1234567.json`),
    { MAX_STREAMS: '2' },
    {},
  );
  const { streams } = await res.json();
  assert.equal(streams.length, 2);
});

test('PROXY_HLS=1: la URL apunta a la pasarela del Worker', async () => {
  mockFetch(() => htmlResponse('<script>p({file:"https://cdn.example.net/master.m3u8"})</script>'));
  const res = await worker.fetch(
    new Request(`${WORKER_URL}/stream/movie/tt1234567.json`),
    { PROXY_HLS: '1' },
    {},
  );
  const { streams } = await res.json();
  assert.equal(
    streams[0].url,
    `${WORKER_URL}/proxy?url=${encodeURIComponent('https://cdn.example.net/master.m3u8')}`,
  );
  assert.equal(streams[0].behaviorHints.notWebReady, false);
});

// ---------------------------------------------------------------------------
// /proxy — pasarela HLS
// ---------------------------------------------------------------------------
test('/proxy: reescribe un playlist hacia el propio Worker', async () => {
  const playlist = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXTINF:4.0,', 'seg0.ts', '#EXT-X-ENDLIST'].join('\n');
  const calls = mockFetch(() =>
    new Response(playlist, {
      status: 200,
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
    }),
  );

  const target = 'https://cdn.example.net/hls/tt1/index.m3u8';
  const res = await call(`/proxy?url=${encodeURIComponent(target)}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /mpegurl/);

  const body = await res.text();
  assert.ok(body.includes('#EXTM3U'));
  assert.ok(body.includes(`${WORKER_URL}/proxy?url=https%3A%2F%2Fcdn.example.net%2Fhls%2Ftt1%2Fseg0.ts`));

  // El proxy inyecta Referer/UA al pedir al CDN.
  assert.equal(calls[0].init.headers.Referer, 'https://unlimplay.com/');
  assert.match(calls[0].init.headers['User-Agent'], /^Mozilla\/5\.0/);
});

test('/proxy: reenvía segmentos con Range y sin reescribir', async () => {
  mockFetch(() =>
    new Response(new Uint8Array([1, 2, 3]), {
      status: 206,
      headers: { 'Content-Type': 'video/mp2t', 'Content-Range': 'bytes 0-2/3' },
    }),
  );
  const res = await call(`/proxy?url=${encodeURIComponent('https://cdn.example.net/s/seg1.ts')}`, {
    headers: { Range: 'bytes=0-2' },
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('Content-Type'), 'video/mp2t');
  assert.equal(res.headers.get('Content-Range'), 'bytes 0-2/3');
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3]);
});

test('/proxy: valida parámetros y bloquea bucles', async () => {
  mockFetch(() => htmlResponse('ok'));

  assert.equal((await call('/proxy')).status, 400);
  assert.equal((await call('/proxy?url=no-es-una-url')).status, 400);
  assert.equal((await call(`/proxy?url=${encodeURIComponent('ftp://x.com/a.m3u8')}`)).status, 400);
  assert.equal(
    (await call(`/proxy?url=${encodeURIComponent(`${WORKER_URL}/proxy?url=x`)}`)).status,
    400,
  );
});

test('/proxy: fallo del CDN → 502 JSON (no rompe el Worker)', async () => {
  mockFetch(() => {
    throw new Error('conexión rechazada');
  });
  const res = await call(`/proxy?url=${encodeURIComponent('https://cdn.example.net/index.m3u8')}`);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'No se pudo obtener el recurso');
});

// ---------------------------------------------------------------------------
// Regresiones
// ---------------------------------------------------------------------------
test('regresión: un mensaje de error con Unicode no rompe la cabecera HTTP', async () => {
  // Las cabeceras sólo admiten ByteString (Latin-1). Antes, un "→" en el
  // mensaje de error lanzaba al construir la respuesta de diagnóstico.
  mockFetch(() => {
    throw new Error('fallo de red → 💥 conexión reiniciada');
  });
  const res = await call('/stream/movie/tt1234567.json');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { streams: [] });
  assert.equal(res.headers.get('X-Proxy-Error'), 'upstream');
  const detail = res.headers.get('X-Proxy-Detail');
  assert.ok(detail && detail.length > 0, 'X-Proxy-Detail debe llegar saneado');
  assert.ok([...detail].every((c) => c.charCodeAt(0) <= 0xff), 'sin caracteres no Latin-1');
});

test('regresión: ids con mayúsculas no se pierden al enrutar', async () => {
  const calls = mockFetch(() => htmlResponse(EMBED_HTML));
  await call('/stream/movie/TT9999999.json');
  assert.equal(calls[0].url, 'https://unlimplay.com/f/embed/movie/TT9999999');
});

test('embed con HTML enorme: conserva cabeza y cola y sigue extrayendo', async () => {
  const junk = '<!-- x -->'.repeat(400000); // ~4 MB de ruido
  mockFetch(() => htmlResponse(`${junk}<script>p({file:"https://cdn.example.net/big.m3u8"})</script>`));
  const res = await call('/stream/movie/tt1234567.json');
  const { streams } = await res.json();
  // El .m3u8 va al final del documento: truncateSmart() debe conservar la cola.
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://cdn.example.net/big.m3u8');
});

test('raíz con Accept: text/html → consola de pruebas en HTML', async () => {
  const res = await call('/', { headers: { Accept: 'text/html,application/xhtml+xml' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /text\/html/);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  const html = await res.text();
  assert.match(html, /com\.cf\.unlimplay\.proxy/);
  assert.match(html, /UnlimPlay Proxy Stream/);
  assert.ok(html.includes(`${WORKER_URL}/manifest.json`), 'debe mostrar la URL de instalación');
  assert.match(html, /<input id="mid"/);
  assert.match(html, /X-Proxy-Detail/);
});

test('raíz con Accept: application/json → healthcheck JSON', async () => {
  const res = await call('/', { headers: { Accept: 'application/json' } });
  assert.match(res.headers.get('Content-Type'), /application\/json/);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.source, 'https://unlimplay.com');
});

test('/index.json siempre devuelve JSON aunque se pida HTML', async () => {
  const res = await call('/index.json', { headers: { Accept: 'text/html' } });
  assert.match(res.headers.get('Content-Type'), /application\/json/);
  assert.equal((await res.json()).status, 'ok');
});

test('SOURCE_ORIGIN por env se refleja en el manifiesto y en el embed', async () => {
  const calls = mockFetch(() => htmlResponse(EMBED_HTML));
  const env = { SOURCE_ORIGIN: 'https://mirror.example.org' };

  const manifest = await (
    await worker.fetch(new Request(`${WORKER_URL}/manifest.json`), env, {})
  ).json();
  assert.equal(manifest.logo, 'https://mirror.example.org/favicon.ico');

  const res = await worker.fetch(
    new Request(`${WORKER_URL}/stream/movie/tt1234567.json`),
    env,
    {},
  );
  const { streams } = await res.json();
  assert.equal(calls[0].url, 'https://mirror.example.org/f/embed/movie/tt1234567');
  assert.equal(streams[0].behaviorHints.requestHeaders.Referer, 'https://mirror.example.org/');
});
