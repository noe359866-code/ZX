/**
 * Pruebas de integración del router del Worker.
 * Se sustituye el fetch() global por un mock, así no se toca la red real.
 *
 * Ejecutar con:  npm test
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import workerImplementation from '../src/index.js';

const VIEW_KEY = 'test-view-key';

// La mayoría de los tests prueban el extractor sin una segunda petición HLS;
// los casos de verify explícito activan VERIFY_HLS=1 en su env. La view_key de
// prueba se inyecta por defecto; los tests que la omiten lo hacen explícito.
const worker = {
  fetch(request, env = {}, ctx = {}) {
    return workerImplementation.fetch(
      request,
      { VERIFY_HLS: '0', VIMEUS_VIEW_KEY: VIEW_KEY, ...env },
      ctx,
    );
  },
};

const WORKER_URL = 'https://unlimplay-proxy.user.workers.dev';
const EMBED_URL = `https://vimeus.com/e/movie?imdb=tt1234567&view_key=${VIEW_KEY}`;

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

const playlistResponse = () =>
  new Response('#EXTM3U\n#EXTINF:4,\nsegment.ts\n', {
    status: 200,
    headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
  });

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
  assert.equal(body.provider, 'vimeus');
  assert.equal(body.vimeusConfigured, true);
  assert.equal(body.catalogsEnabled, false);
  assert.equal(body.install, `${WORKER_URL}/manifest.json`);
  assert.ok(!JSON.stringify(body).includes(VIEW_KEY), 'el healthcheck no expone la view_key');
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
  assert.equal(m.name, 'Vimeus HLS');
  assert.equal(m.logo, 'https://vimeus.com/favicon.ico');
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
      file: "https:\\/\\/cdn.vimeus.test\\/hls\\/tt1234567\\/master.m3u8?token=abc123",
      type: "application/x-mpegURL"
    }]
  });
</script></body></html>`;

test('GET /stream/movie/{id}.json: pide el embed de Vimeus y responde a Stremio', async () => {
  const calls = mockFetch((url) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://vimeus.com');
    assert.equal(parsed.pathname, '/e/movie');
    assert.equal(parsed.searchParams.get('imdb'), 'tt1234567');
    assert.equal(parsed.searchParams.get('view_key'), VIEW_KEY);
    return htmlResponse(EMBED_HTML);
  });

  const res = await call('/stream/movie/tt1234567.json');
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.streams.length, 1);

  const stream = body.streams[0];
  assert.equal(stream.name, 'Vimeus HLS');
  assert.equal(stream.title, 'Vimeus [HLS]');
  assert.equal(stream.type, 'hls');
  assert.equal(stream.url, 'https://cdn.vimeus.test/hls/tt1234567/master.m3u8?token=abc123');

  assert.equal(stream.behaviorHints.notSupported, false);
  assert.equal(stream.behaviorHints.requestHeaders.Referer, 'https://vimeus.com/');
  assert.match(stream.behaviorHints.requestHeaders['User-Agent'], /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\)/);
  assert.equal(stream.behaviorHints.proxyHeaders.request.Origin, 'https://vimeus.com');
  assert.equal(stream.behaviorHints.bingeGroup, 'vimeus-0');

  assert.equal(res.headers.get('X-Stream-Provider'), 'vimeus');
  assert.equal(res.headers.get('X-Candidates-Found'), '1');

  // Cabeceras de navegador moderno en la petición de scraping.
  assert.equal(calls.length, 1);
  assert.match(calls[0].init.headers['User-Agent'], /Chrome\/\d+.*Safari\/537\.36/);
  assert.equal(calls[0].init.headers.Referer, 'https://vimeus.com/');
  assert.ok(!JSON.stringify(body).includes(VIEW_KEY), 'view_key no se filtra al cliente');
});

test('VIMEUS_REFERER se propaga a Stremio y al scraping', async () => {
  const calls = mockFetch(() =>
    htmlResponse('<script>player.setup({file:"https://cdn.vimeus.test/master.m3u8?token=short"})</script>'),
  );

  const res = await worker.fetch(
    new Request(`${WORKER_URL}/stream/movie/tt1234567.json`),
    { VIMEUS_REFERER: 'https://allowed.example/' },
    {},
  );
  const body = await res.json();

  assert.equal(body.streams.length, 1);
  assert.equal(body.streams[0].url, 'https://cdn.vimeus.test/master.m3u8?token=short');
  assert.equal(body.streams[0].behaviorHints.requestHeaders.Referer, 'https://allowed.example/');
  assert.equal(calls[0].init.headers.Referer, 'https://allowed.example/');
});

test('sin VIMEUS_VIEW_KEY: no consulta el origen y devuelve streams vacío', async () => {
  const calls = mockFetch(() => htmlResponse(EMBED_HTML));
  const res = await worker.fetch(
    new Request(`${WORKER_URL}/stream/movie/tt1234567.json`),
    { VIMEUS_VIEW_KEY: '' },
    {},
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { streams: [] });
  assert.equal(res.headers.get('X-Proxy-Error'), 'missing-view-key');
  assert.equal(res.headers.get('X-Stream-Provider'), null);
  assert.equal(calls.length, 0);
});

test('VIEW_KEY (alias heredado) también configura la clave', async () => {
  const calls = mockFetch(() => htmlResponse(EMBED_HTML));
  const res = await worker.fetch(
    new Request(`${WORKER_URL}/stream/movie/tt1234567.json`),
    { VIMEUS_VIEW_KEY: '', VIEW_KEY: 'legacy-key' },
    {},
  );
  assert.equal((await res.json()).streams.length, 1);
  assert.equal(new URL(calls[0].url).searchParams.get('view_key'), 'legacy-key');
});

test('VERIFY_HLS acepta un HLS válido y usa las cabeceras del proveedor', async () => {
  const calls = mockFetch((url, init) => {
    if (url.startsWith('https://vimeus.com/e/movie?')) {
      return htmlResponse('<script>player.setup({file:"https://cdn.vimeus.test/live.m3u8?token=fresh"})</script>');
    }
    if (url === 'https://cdn.vimeus.test/live.m3u8?token=fresh') {
      assert.equal(init.headers.Referer, 'https://allowed.example/');
      return playlistResponse();
    }
    throw new Error(`petición inesperada: ${url}`);
  });

  const res = await worker.fetch(
    new Request(`${WORKER_URL}/stream/movie/tt1234567.json`),
    { VERIFY_HLS: '1', VIMEUS_REFERER: 'https://allowed.example/' },
    {},
  );
  const body = await res.json();
  assert.equal(res.headers.get('X-Stream-Provider'), 'vimeus');
  assert.equal(body.streams[0].url, 'https://cdn.vimeus.test/live.m3u8?token=fresh');
  assert.equal(calls.length, 2, 'una petición al embed y otra a la playlist');
});

test('VERIFY_HLS: si la playlist devuelve 403 no hay streams y se diagnostica', async () => {
  const calls = mockFetch((url) => {
    if (url.startsWith('https://vimeus.com/e/movie?')) {
      return htmlResponse('<script>player.setup({file:"https://cdn.vimeus.test/expired.m3u8?token=old"})</script>');
    }
    if (url === 'https://cdn.vimeus.test/expired.m3u8?token=old') {
      return new Response('token expired', { status: 403 });
    }
    throw new Error(`petición inesperada: ${url}`);
  });

  const res = await worker.fetch(
    new Request(`${WORKER_URL}/stream/movie/tt1234567.json`),
    { VERIFY_HLS: '1' },
    {},
  );
  assert.deepEqual(await res.json(), { streams: [] });
  assert.equal(res.headers.get('X-Proxy-Error'), 'upstream');
  assert.match(res.headers.get('X-Proxy-Detail'), /403/);
  assert.equal(calls.length, 2, 'no existe ningún proveedor de respaldo que consultar');
});

test('VERIFY_HLS descarta páginas HTML servidas con HTTP 200', async () => {
  const calls = mockFetch((url) => {
    if (url.startsWith('https://vimeus.com/e/movie?')) {
      return htmlResponse('<script>player.setup({file:"https://cdn.vimeus.test/fake.m3u8"})</script>');
    }
    if (url === 'https://cdn.vimeus.test/fake.m3u8') return htmlResponse('<html>Error</html>');
    throw new Error(`petición inesperada: ${url}`);
  });

  const res = await worker.fetch(
    new Request(`${WORKER_URL}/stream/movie/tt1234567.json`),
    { VERIFY_HLS: '1' },
    {},
  );
  assert.deepEqual(await res.json(), { streams: [] });
  assert.equal(res.headers.get('X-Proxy-Error'), 'upstream');
  assert.equal(calls.length, 2);
});

test('series: si /e/serie no encuentra HLS, intenta /e/anime para un episodio', async () => {
  const calls = mockFetch((url) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('tmdb'), '1429');
    assert.equal(parsed.searchParams.get('se'), '2');
    assert.equal(parsed.searchParams.get('ep'), '3');
    assert.equal(parsed.searchParams.get('view_key'), VIEW_KEY);
    if (parsed.pathname === '/e/serie') return htmlResponse('<html>sin fuente</html>');
    if (parsed.pathname === '/e/anime') {
      return htmlResponse('<script>player.setup({file:"https://cdn.vimeus.test/episode.m3u8"})</script>');
    }
    throw new Error(`endpoint Vimeus inesperado: ${url}`);
  });

  const res = await call('/stream/series/tmdb%3A1429%3A2%3A3.json');
  const body = await res.json();

  assert.equal(body.streams.length, 1);
  assert.equal(body.streams[0].url, 'https://cdn.vimeus.test/episode.m3u8');
  assert.equal(res.headers.get('X-Stream-Provider'), 'vimeus');
  assert.deepEqual(calls.map((c) => new URL(c.url).pathname), ['/e/serie', '/e/anime']);
});

test('VERIFY_HLS prueba /e/anime si el HLS de /e/serie está vencido', async () => {
  const calls = mockFetch((url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/e/serie') {
      return htmlResponse('<script>player.setup({file:"https://cdn.vimeus.test/expired.m3u8"})</script>');
    }
    if (url === 'https://cdn.vimeus.test/expired.m3u8') {
      return new Response('expired', { status: 403 });
    }
    if (parsed.pathname === '/e/anime') {
      return htmlResponse('<script>player.setup({file:"https://cdn.vimeus.test/valid.m3u8"})</script>');
    }
    if (url === 'https://cdn.vimeus.test/valid.m3u8') return playlistResponse();
    throw new Error(`petición inesperada: ${url}`);
  });

  const res = await worker.fetch(
    new Request(`${WORKER_URL}/stream/series/tmdb%3A1429%3A2%3A3.json`),
    { VERIFY_HLS: '1' },
    {},
  );
  const body = await res.json();
  assert.equal(body.streams[0].url, 'https://cdn.vimeus.test/valid.m3u8');
  // /e/serie y /e/anime se piden en paralelo; después se verifican las playlists.
  assert.deepEqual(calls.map((c) => new URL(c.url).pathname), [
    '/e/serie', '/e/anime', '/expired.m3u8', '/valid.m3u8',
  ]);
});

test('series: traduce id:temporada:episodio con IMDb y consulta /e/serie y /e/anime en paralelo', async () => {
  const calls = mockFetch((url) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('imdb'), 'tt0903747');
    assert.equal(parsed.searchParams.get('se'), '1');
    assert.equal(parsed.searchParams.get('ep'), '2');
    // Catálogos disjuntos: el que no corresponde responde 404 de inmediato.
    if (parsed.pathname === '/e/anime') return new Response('Not Found', { status: 404 });
    assert.equal(parsed.pathname, '/e/serie');
    return htmlResponse('<script>player.setup({file:"https://cdn.example.net/episode.m3u8"})</script>');
  });

  const res = await call('/stream/series/tt0903747:1:2.json');
  const { streams } = await res.json();
  assert.equal(streams.length, 1);
  assert.deepEqual(calls.map((c) => new URL(c.url).pathname).sort(), ['/e/anime', '/e/serie']);
});

test('series: un título que sólo existe en /e/anime se resuelve igual', async () => {
  const calls = mockFetch((url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/e/serie') return new Response('Not Found', { status: 404 });
    return htmlResponse('<script>player.setup({file:"https://cdn.example.net/anime.m3u8"})</script>');
  });
  const res = await call('/stream/series/tmdb:37854:1:1.json');
  const { streams } = await res.json();
  assert.equal(streams[0].url, 'https://cdn.example.net/anime.m3u8');
  assert.equal(calls.length, 2);
});

test('series: 404 en /e/serie y /e/anime → not-found con detalle claro', async () => {
  mockFetch(() => new Response('Not Found', { status: 404 }));
  const res = await call('/stream/series/tt0000001:1:1.json');
  assert.deepEqual(await res.json(), { streams: [] });
  assert.equal(res.headers.get('X-Proxy-Error'), 'not-found');
  assert.match(res.headers.get('X-Proxy-Detail'), /404/);
});

test('series: también acepta tmdb id en segmentos y rechaza episodio incompleto', async () => {
  const calls = mockFetch(() =>
    htmlResponse('<script>player.setup({file:"https://cdn.example.net/episode.m3u8"})</script>'),
  );
  const res = await call('/stream/tv/1396/1/1.json');
  assert.equal((await res.json()).streams.length, 1);
  const first = new URL(calls[0].url);
  assert.equal(first.pathname, '/e/serie');
  assert.equal(first.searchParams.get('tmdb'), '1396');
  assert.equal(first.searchParams.get('se'), '1');
  assert.equal(first.searchParams.get('ep'), '1');
  const requested = calls.length;

  const invalid = await call('/stream/series/tt0903747.json');
  assert.deepEqual(await invalid.json(), { streams: [] });
  assert.equal(invalid.headers.get('X-Proxy-Error'), 'bad-id');
  assert.equal(calls.length, requested, 'no consulta el origen para un episodio incompleto');
});

test('403 de Vimeus → invalid-view-key sin filtrar la clave en el diagnóstico', async () => {
  const secret = 'private-view-key-value';
  mockFetch(() => new Response('no autorizado', { status: 403 }));
  const res = await worker.fetch(
    new Request(`${WORKER_URL}/stream/movie/tt1234567.json`),
    { VIMEUS_VIEW_KEY: secret },
    {},
  );
  const detail = res.headers.get('X-Proxy-Detail') || '';
  assert.equal(res.headers.get('X-Proxy-Error'), 'invalid-view-key');
  assert.match(detail, /403/);
  assert.ok(!detail.includes(secret));
});

test('400 "view_key is required" (clave inválida) → invalid-view-key', async () => {
  const calls = mockFetch(() => new Response('Bad Request: view_key is required.', { status: 400 }));
  const res = await call('/stream/movie/tt1234567.json');
  assert.deepEqual(await res.json(), { streams: [] });
  assert.equal(res.headers.get('X-Proxy-Error'), 'invalid-view-key');
  assert.match(res.headers.get('X-Proxy-Detail'), /VIMEUS_VIEW_KEY/);
  assert.equal(calls.length, 1, 'sin deep scan ni reintentos');
});

test('404 de Vimeus en película → not-found sin deep scan', async () => {
  const calls = mockFetch(() => new Response('Not Found', { status: 404 }));
  const res = await call('/stream/movie/tt1234567.json');
  assert.equal(res.headers.get('X-Proxy-Error'), 'not-found');
  assert.match(res.headers.get('X-Proxy-Detail'), /404/);
  assert.equal(calls.length, 1);
});

test('el id se limpia: tmdb:movie:550.json → tmdb=550', async () => {
  const calls = mockFetch(() => htmlResponse(EMBED_HTML));
  const res = await call('/stream/movie/tmdb:movie:550.json');
  assert.equal(res.status, 200);
  const parsed = new URL(calls[0].url);
  assert.equal(parsed.searchParams.get('tmdb'), '550');
  assert.equal(parsed.searchParams.get('imdb'), null);
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

test('HTML sin .m3u8: devuelve {"streams": []} con not-found', async () => {
  mockFetch(() => htmlResponse('<html><body><p>sin vídeo</p></body></html>'));
  const res = await call('/stream/movie/tt1234567.json');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { streams: [] });
  assert.equal(res.headers.get('X-Proxy-Error'), 'not-found');
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
    if (url === 'https://vimeus.com/api/source/tt1234567') {
      return new Response(JSON.stringify({ file: 'https://cdn.vimeus.test/x/master.m3u8?t=1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`petición inesperada: ${url}`);
  });

  const res = await call('/stream/movie/tt1234567.json');
  const body = await res.json();
  assert.equal(body.streams.length, 1);
  assert.equal(body.streams[0].url, 'https://cdn.vimeus.test/x/master.m3u8?t=1');
  assert.equal(calls.length, 2, 'una petición al embed + una al endpoint de configuración');
});

test('deep scan sigue iframes anidados hasta la configuración HLS', async () => {
  const calls = mockFetch((url) => {
    if (url === EMBED_URL) return htmlResponse('<iframe src="/embed/player/tt1234567"></iframe>');
    if (url === 'https://vimeus.com/embed/player/tt1234567') {
      return htmlResponse('<iframe src="/player/config.php?id=tt1234567"></iframe>');
    }
    if (url === 'https://vimeus.com/player/config.php?id=tt1234567') {
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
  assert.equal(streams[0].title, 'Vimeus [HLS]');
  assert.match(streams[1].title, /^Vimeus \[HLS · Alt 2\]$/);
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
// Mejoras del extractor y del deep scan (integración)
// ---------------------------------------------------------------------------
test('VERIFY_HLS: etiqueta la calidad leyendo la master playlist', async () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720', '720.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080', '1080.m3u8',
  ].join('\n');
  mockFetch((url) => {
    if (url === EMBED_URL) return htmlResponse('<script>p({file:"https://cdn.vimeus.test/master.m3u8"})</script>');
    if (url === 'https://cdn.vimeus.test/master.m3u8') {
      return new Response(master, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    }
    throw new Error(`petición inesperada: ${url}`);
  });

  const res = await worker.fetch(new Request(`${WORKER_URL}/stream/movie/tt1234567.json`), { VERIFY_HLS: '1' }, {});
  const { streams } = await res.json();
  assert.equal(streams[0].title, 'Vimeus [HLS · 1080p]');
});

test('VERIFY_HLS: marca LIVE en una media playlist sin ENDLIST', async () => {
  mockFetch((url) => {
    if (url === EMBED_URL) return htmlResponse('<script>p({file:"https://cdn.vimeus.test/live.m3u8"})</script>');
    return new Response('#EXTM3U\n#EXTINF:4,\nseg.ts\n', { status: 200 });
  });
  const res = await worker.fetch(new Request(`${WORKER_URL}/stream/movie/tt1234567.json`), { VERIFY_HLS: '1' }, {});
  const { streams } = await res.json();
  assert.equal(streams[0].title, 'Vimeus [HLS · LIVE]');
});

test('VERIFY_HLS: verifica en paralelo y conserva el orden de confianza', async () => {
  const order = [];
  mockFetch((url) => {
    if (url === EMBED_URL) {
      return htmlResponse(`
        <script>a({file:"https://c1.example.net/slow.m3u8"});</script>
        <script>var alt = "https://c2.example.net/fast.m3u8";</script>`);
    }
    order.push(url);
    const delay = url.includes('slow') ? 40 : 1;
    return new Promise((resolve) =>
      setTimeout(() => resolve(new Response('#EXTM3U\n#EXTINF:4,\nx.ts\n#EXT-X-ENDLIST', { status: 200 })), delay),
    );
  });

  const t0 = Date.now();
  const res = await worker.fetch(new Request(`${WORKER_URL}/stream/movie/tt1234567.json`), { VERIFY_HLS: '1' }, {});
  const { streams } = await res.json();
  assert.deepEqual(streams.map((s) => s.url), ['https://c1.example.net/slow.m3u8', 'https://c2.example.net/fast.m3u8']);
  assert.equal(order.length, 2, 'ambas playlists se solicitan');
  assert.ok(Date.now() - t0 < 200, 'las verificaciones no se encadenan en serie');
});

test('deep scan: endpoints de API reciben cabeceras XHR; los iframes, cabeceras de documento', async () => {
  const seen = {};
  mockFetch((url, init) => {
    seen[url] = init.headers;
    if (url === EMBED_URL) return htmlResponse('<iframe src="/embed/inner"></iframe>');
    if (url === 'https://vimeus.com/embed/inner') return htmlResponse('<script>fetch("/api/source/tt1234567")</script>');
    if (url === 'https://vimeus.com/api/source/tt1234567') {
      return new Response(JSON.stringify({ file: 'https://cdn.vimeus.test/x/master.m3u8' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`petición inesperada: ${url}`);
  });

  const res = await call('/stream/movie/tt1234567.json');
  const { streams } = await res.json();
  assert.equal(streams[0].url, 'https://cdn.vimeus.test/x/master.m3u8');

  const iframeHeaders = seen['https://vimeus.com/embed/inner'];
  assert.equal(iframeHeaders['Sec-Fetch-Dest'], 'iframe');
  assert.equal(iframeHeaders['X-Requested-With'], undefined);
  assert.equal(iframeHeaders.Referer, EMBED_URL);

  const apiHeaders = seen['https://vimeus.com/api/source/tt1234567'];
  assert.equal(apiHeaders['X-Requested-With'], 'XMLHttpRequest');
  assert.match(apiHeaders.Accept, /^application\/json/);
  assert.equal(apiHeaders['Sec-Fetch-Mode'], 'cors');
  assert.equal(apiHeaders.Referer, 'https://vimeus.com/embed/inner');
});

test('deep scan: sigue una redirección por meta refresh hasta el player', async () => {
  const calls = mockFetch((url) => {
    if (url === EMBED_URL) return htmlResponse('<meta http-equiv="refresh" content="0; url=/watch/real?id=tt1234567">');
    if (url === 'https://vimeus.com/watch/real?id=tt1234567') {
      return htmlResponse('<script>p({file:"https://cdn.vimeus.test/real/master.m3u8"})</script>');
    }
    throw new Error(`petición inesperada: ${url}`);
  });
  const res = await call('/stream/movie/tt1234567.json');
  const { streams } = await res.json();
  assert.equal(streams[0].url, 'https://cdn.vimeus.test/real/master.m3u8');
  assert.equal(calls.length, 2);
});

test('embed con script empaquetado (p.a.c.k.e.r): se extrae el HLS sin ejecutar JS', async () => {
  // Fixture real generado con el packer de Dean Edwards en base 62.
  const packed =
    "eval(function(p,a,c,k,e,d){e=function(c){return(c<a?'':e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};" +
    "if(!''.replace(/^/,String)){while(c--){d[e(c)]=k[c]||e(c)}k=[function(e){return d[e]}];e=function(){return'\\w+'};c=1};" +
    "while(c--){if(k[c]){p=p.replace(new RegExp('\\b'+e(c)+'\\b','g'),k[c])}}return p}" +
    "('0 1=2(\"3\");1.4({5:[{6:\"7://8.9.a/b/c/d.e?f=g\",h:\"b\"}],i:\"/j.k\"});',21,21," +
    "'var|player|jwplayer|vplayer|setup|sources|file|https|cdn-packed|example|net|hls|abc123|master|m3u8|token|p4ck3d|type|image|poster|jpg'.split('|'),0,{}))";
  mockFetch(() => htmlResponse(`<html><body><div id="vplayer"></div><script>${packed}</script></body></html>`));
  const res = await call('/stream/movie/tt1234567.json');
  const { streams } = await res.json();
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://cdn-packed.example.net/hls/abc123/master.m3u8?token=p4ck3d');
});

test('embed con fuente HLS sin extensión .m3u8 (type: application/x-mpegURL)', async () => {
  mockFetch((url) => {
    if (url === EMBED_URL) {
      return htmlResponse('<script>p.setup({sources:[{src:"https://cdn.vimeus.test/vod/777/stream",type:"application/x-mpegURL"}]})</script>');
    }
    if (url === 'https://cdn.vimeus.test/vod/777/stream') return new Response('#EXTM3U\n#EXTINF:4,\nx.ts\n#EXT-X-ENDLIST', { status: 200 });
    throw new Error(`petición inesperada: ${url}`);
  });
  const res = await worker.fetch(new Request(`${WORKER_URL}/stream/movie/tt1234567.json`), { VERIFY_HLS: '1' }, {});
  const { streams } = await res.json();
  assert.equal(streams[0].url, 'https://cdn.vimeus.test/vod/777/stream');
  assert.equal(streams[0].type, 'hls');
});

// ---------------------------------------------------------------------------
// Vimeus como agregador: el HLS vive en un host de terceros
// ---------------------------------------------------------------------------
test('HLS hallado en un iframe de terceros: Referer/Origin del tercero, no de Vimeus', async () => {
  const seen = {};
  mockFetch((url, init) => {
    seen[url] = init.headers;
    if (url === EMBED_URL) return htmlResponse('<iframe src="https://streamhost.example/e/abc123"></iframe>');
    if (url === 'https://streamhost.example/e/abc123') {
      return htmlResponse('<script>jwplayer().setup({file:"https://cdn.streamhost.example/hls/abc123/master.m3u8?t=1"})</script>');
    }
    if (url === 'https://cdn.streamhost.example/hls/abc123/master.m3u8?t=1') {
      return new Response('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720\n720.m3u8', { status: 200 });
    }
    throw new Error(`petición inesperada: ${url}`);
  });

  const res = await worker.fetch(
    new Request(`${WORKER_URL}/stream/movie/tt1234567.json`),
    { VERIFY_HLS: '1', VIMEUS_REFERER: 'https://misitio.example/' },
    {},
  );
  const { streams } = await res.json();
  assert.equal(streams.length, 1);
  assert.equal(streams[0].title, 'Vimeus [HLS · 720p]');

  // La verificación de la playlist usó el Referer del host de terceros.
  const verify = seen['https://cdn.streamhost.example/hls/abc123/master.m3u8?t=1'];
  assert.equal(verify.Referer, 'https://streamhost.example/');
  assert.equal(verify.Origin, 'https://streamhost.example');

  // Y Stremio recibe esas mismas cabeceras para reproducir.
  assert.equal(streams[0].behaviorHints.requestHeaders.Referer, 'https://streamhost.example/');
  assert.equal(streams[0].behaviorHints.proxyHeaders.request.Origin, 'https://streamhost.example');

  // El embed de Vimeus, en cambio, se pidió con el Referer autorizado.
  assert.equal(seen[EMBED_URL].Referer, 'https://misitio.example/');
  // El iframe de terceros se pidió con el embed de Vimeus como Referer.
  assert.equal(seen['https://streamhost.example/e/abc123'].Referer, EMBED_URL);
});

test('HLS hallado en la propia página de Vimeus conserva VIMEUS_REFERER', async () => {
  mockFetch(() => htmlResponse('<script>p({file:"https://cdn.vimeus.test/direct.m3u8"})</script>'));
  const res = await worker.fetch(
    new Request(`${WORKER_URL}/stream/movie/tt1234567.json`),
    { VIMEUS_REFERER: 'https://misitio.example/' },
    {},
  );
  const { streams } = await res.json();
  assert.equal(streams[0].behaviorHints.requestHeaders.Referer, 'https://misitio.example/');
  assert.equal(streams[0].behaviorHints.proxyHeaders.request.Origin, 'https://vimeus.com');
});

test('PROXY_HLS=1 con HLS de terceros: la URL del proxy lleva ref=<origen del tercero>', async () => {
  mockFetch((url) => {
    if (url === EMBED_URL) return htmlResponse('<iframe src="https://streamhost.example/e/x"></iframe>');
    return htmlResponse('<script>p({file:"https://cdn.streamhost.example/x/master.m3u8"})</script>');
  });
  const res = await worker.fetch(
    new Request(`${WORKER_URL}/stream/movie/tt1234567.json`),
    { PROXY_HLS: '1' },
    {},
  );
  const { streams } = await res.json();
  const proxied = new URL(streams[0].url);
  assert.equal(proxied.pathname, '/proxy');
  assert.equal(proxied.searchParams.get('url'), 'https://cdn.streamhost.example/x/master.m3u8');
  assert.equal(proxied.searchParams.get('ref'), 'https://streamhost.example');
});

test('/proxy?ref=: aplica el Referer del tercero y lo propaga a las variantes', async () => {
  const calls = mockFetch((url, init) => {
    assert.equal(init.headers.Referer, 'https://streamhost.example/');
    assert.equal(init.headers.Origin, 'https://streamhost.example');
    return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n720/index.m3u8\n', {
      status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
    });
  });
  const target = 'https://cdn.streamhost.example/x/master.m3u8';
  const res = await call(`/proxy?url=${encodeURIComponent(target)}&ref=${encodeURIComponent('https://streamhost.example')}`);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.ok(body.includes(`${WORKER_URL}/proxy?url=https%3A%2F%2Fcdn.streamhost.example%2Fx%2F720%2Findex.m3u8&ref=https%3A%2F%2Fstreamhost.example`));
  assert.equal(calls.length, 1);
});

test('/proxy?ref=: ignora valores inválidos o que apuntan al Worker', async () => {
  const calls = mockFetch(() => new Response(new Uint8Array([1]), { status: 200, headers: { 'Content-Type': 'video/mp2t' } }));
  for (const ref of ['javascript:alert(1)', WORKER_URL, 'nohost', 'ftp://x.y']) {
    const res = await call(`/proxy?url=${encodeURIComponent('https://cdn.example.net/s.ts')}&ref=${encodeURIComponent(ref)}`);
    assert.equal(res.status, 200);
  }
  for (const c of calls) assert.equal(c.init.headers.Referer, 'https://vimeus.com/');
});

test('deep scan: dos iframes (selector de servidores) se piden en el mismo lote', async () => {
  const order = [];
  mockFetch((url) => {
    order.push(url);
    if (url === EMBED_URL) {
      return htmlResponse('<iframe src="https://host-a.example/e/1"></iframe><iframe src="https://host-b.example/e/2"></iframe>');
    }
    if (url === 'https://host-a.example/e/1') return htmlResponse('<p>servidor caído</p>');
    if (url === 'https://host-b.example/e/2') {
      return htmlResponse('<script>p({file:"https://cdn.hostb.example/v/master.m3u8"})</script>');
    }
    throw new Error(`petición inesperada: ${url}`);
  });
  const res = await call('/stream/movie/tt1234567.json');
  const { streams } = await res.json();
  assert.equal(streams[0].url, 'https://cdn.hostb.example/v/master.m3u8');
  assert.equal(streams[0].behaviorHints.requestHeaders.Referer, 'https://host-b.example/');
  assert.equal(order.length, 3);
});

test('MAX_DEEP_SCAN acota las peticiones del deep scan', async () => {
  const calls = mockFetch((url) => {
    if (url === EMBED_URL) {
      return htmlResponse([1, 2, 3, 4, 5, 6, 7, 8].map((i) => `<iframe src="/embed/s${i}"></iframe>`).join(''));
    }
    return htmlResponse('<p>nada</p>');
  });
  const res = await worker.fetch(
    new Request(`${WORKER_URL}/stream/movie/tt1234567.json`),
    { MAX_DEEP_SCAN: '3' },
    {},
  );
  assert.deepEqual(await res.json(), { streams: [] });
  assert.equal(calls.length, 1 + 3);
});

// ---------------------------------------------------------------------------
// /debug — traza protegida por DEBUG_TOKEN
// ---------------------------------------------------------------------------
test('/debug: 404 sin DEBUG_TOKEN configurado o con token incorrecto', async () => {
  const calls = mockFetch(() => htmlResponse(EMBED_HTML));
  assert.equal((await call('/debug/movie/tt1234567?token=abc')).status, 404);
  const wrong = await worker.fetch(new Request(`${WORKER_URL}/debug/movie/tt1234567?token=nope`), { DEBUG_TOKEN: 'abc' }, {});
  assert.equal(wrong.status, 404);
  const missing = await worker.fetch(new Request(`${WORKER_URL}/debug/movie/tt1234567`), { DEBUG_TOKEN: 'abc' }, {});
  assert.equal(missing.status, 404);
  assert.equal(calls.length, 0, 'sin token válido no se toca el origen');
});

test('/debug: devuelve la traza del scraping con secretos redactados', async () => {
  mockFetch((url) => {
    if (url === EMBED_URL) return htmlResponse('<iframe src="https://streamhost.example/e/abc"></iframe>');
    if (url === 'https://streamhost.example/e/abc') {
      return htmlResponse('<script>p({file:"https://cdn.streamhost.example/m.m3u8?token=secreto"})</script>');
    }
    return new Response('#EXTM3U\n#EXTINF:4,\nx.ts\n#EXT-X-ENDLIST', { status: 200 });
  });

  const res = await worker.fetch(
    new Request(`${WORKER_URL}/debug/movie/tt1234567?token=abc&html=1`),
    { DEBUG_TOKEN: 'abc', VERIFY_HLS: '1' },
    {},
  );
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(VIEW_KEY), 'la view_key no aparece');
  assert.ok(!text.includes('token=secreto'), 'los tokens se redactan');
  const body = JSON.parse(text);
  assert.equal(body.provider.viewKey, 'configured');
  assert.equal(body.embeds.length, 1);
  assert.deepEqual(body.trace.map((s) => s.step), ['embed', 'scan', 'verify']);
  assert.ok(body.trace[0].html.includes('<iframe'), 'html=1 incluye el HTML');
  assert.deepEqual(body.trace[0].configUrls, ['https://streamhost.example/e/abc']);
  assert.equal(body.trace[1].candidates.length, 1);
  assert.equal(body.result.code, null);
  assert.equal(body.result.streams[0].referer, 'https://streamhost.example/');
});

test('/debug sin view_key: informa missing-view-key sin tocar el origen', async () => {
  const calls = mockFetch(() => htmlResponse(EMBED_HTML));
  const res = await worker.fetch(
    new Request(`${WORKER_URL}/debug/movie/tt1234567?token=abc`),
    { DEBUG_TOKEN: 'abc', VIMEUS_VIEW_KEY: '' },
    {},
  );
  const body = await res.json();
  assert.equal(body.result.code, 'missing-view-key');
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Catálogos — API de listado (X-API-Key)
// ---------------------------------------------------------------------------
const LISTING_MOVIES = {
  error: false,
  message: 'Success',
  data: {
    movies: [
      { id: 1, content_type: 'movie', tmdb_id: 550, imdb_id: 'tt0137523', title: 'Fight Club', poster: '/pB8.jpg', backdrop: '/fCa.jpg', synced_at: '2025-01-15T10:30:00Z' },
      { id: 2, content_type: 'movie', tmdb_id: 99861, imdb_id: null, title: 'Avengers: Era de Ultrón', poster: null, backdrop: null },
      { id: 3, content_type: 'movie', tmdb_id: 550, imdb_id: 'tt0137523', title: 'Fight Club (dup)' },
      { id: 4, content_type: 'movie', tmdb_id: null, imdb_id: '', title: 'sin ids' },
    ],
    pagination: { current_page: 1, total_pages: 45, total_results: 2234, per_page: 50, has_next: true, has_prev: false },
  },
};

test('manifest: sin VIMEUS_API_KEY no publica catálogos', async () => {
  const m = await (await call('/manifest.json')).json();
  assert.deepEqual(m.resources, ['stream']);
  assert.deepEqual(m.catalogs, []);
});

test('manifest: con VIMEUS_API_KEY publica los tres catálogos con skip', async () => {
  const m = await (await worker.fetch(new Request(`${WORKER_URL}/manifest.json`), { VIMEUS_API_KEY: 'k' }, {})).json();
  assert.deepEqual(m.resources, ['stream', 'catalog']);
  assert.deepEqual(m.catalogs.map((c) => [c.type, c.id]), [
    ['movie', 'vimeus-movies'], ['series', 'vimeus-series'], ['series', 'vimeus-animes'],
  ]);
  assert.deepEqual(m.catalogs[0].extra, [{ name: 'skip', isRequired: false }]);
  assert.ok(!JSON.stringify(m).includes('"k"'), 'la API key no se publica');
});

test('/catalog: traduce el listado a metas de Stremio (IMDb preferido, póster TMDB, sin duplicados)', async () => {
  const calls = mockFetch((url, init) => {
    assert.equal(url, 'https://vimeus.com/api/listing/movies?page=1');
    assert.equal(init.headers['X-API-Key'], 'api-secret');
    return new Response(JSON.stringify(LISTING_MOVIES), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const res = await worker.fetch(new Request(`${WORKER_URL}/catalog/movie/vimeus-movies.json`), { VIMEUS_API_KEY: 'api-secret' }, {});
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Cache-Control'), /max-age=300/);
  assert.equal(res.headers.get('X-Listing-Total-Pages'), '45');
  const { metas } = await res.json();
  assert.deepEqual(metas.map((m) => m.id), ['tt0137523', 'tmdb:99861']);
  assert.equal(metas[0].type, 'movie');
  assert.equal(metas[0].name, 'Fight Club');
  assert.equal(metas[0].poster, 'https://image.tmdb.org/t/p/w500/pB8.jpg');
  assert.equal(metas[0].background, 'https://image.tmdb.org/t/p/w1280/fCa.jpg');
  assert.equal(metas[1].poster, undefined);
  assert.equal(calls.length, 1);
});

test('/catalog: skip se traduce a página (50 por página) y acepta la ruta con extra', async () => {
  const calls = mockFetch(() => new Response(JSON.stringify({ error: false, data: { animes: [
    { tmdb_id: 46261, imdb_id: 'tt2560140', title: 'Attack on Titan', content_type: 'anime' },
  ] } }), { status: 200 }));
  const env = { VIMEUS_API_KEY: 'k' };
  const r1 = await worker.fetch(new Request(`${WORKER_URL}/catalog/series/vimeus-animes/skip=100.json`), env, {});
  const { metas } = await r1.json();
  assert.equal(new URL(calls[0].url).searchParams.get('page'), '3');
  assert.equal(calls[0].url.split('?')[0], 'https://vimeus.com/api/listing/animes');
  assert.equal(metas[0].type, 'series');
  assert.deepEqual(metas[0].genres, ['Anime']);
  assert.equal(r1.headers.get('X-Listing-Page'), '3');

  await worker.fetch(new Request(`${WORKER_URL}/catalog/series/vimeus-series/skip=49.json`), env, {});
  assert.equal(new URL(calls[1].url).searchParams.get('page'), '1');
  assert.equal(calls[1].url.split('?')[0], 'https://vimeus.com/api/listing/series');
});

test('/catalog: errores de la API → metas vacío con diagnóstico, sin romper Stremio', async () => {
  const env = { VIMEUS_API_KEY: 'k' };
  mockFetch(() => new Response(JSON.stringify({ error: true, message: 'API key is required', data: null }), { status: 401 }));
  const unauthorized = await worker.fetch(new Request(`${WORKER_URL}/catalog/movie/vimeus-movies.json`), env, {});
  assert.deepEqual(await unauthorized.json(), { metas: [] });
  assert.equal(unauthorized.headers.get('X-Proxy-Error'), 'invalid-api-key');

  mockFetch(() => new Response(JSON.stringify({ error: true, message: 'No content found', data: null }), { status: 404 }));
  const end = await worker.fetch(new Request(`${WORKER_URL}/catalog/movie/vimeus-movies/skip=5000.json`), env, {});
  assert.deepEqual(await end.json(), { metas: [] });
  assert.equal(end.headers.get('X-Proxy-Error'), null, 'fin de la paginación no es un error');

  mockFetch(() => { throw new Error('red caída'); });
  const down = await worker.fetch(new Request(`${WORKER_URL}/catalog/movie/vimeus-movies.json`), env, {});
  assert.deepEqual(await down.json(), { metas: [] });
  assert.equal(down.headers.get('X-Proxy-Error'), 'upstream');
});

test('/catalog: sin API key o catálogo desconocido no toca la red', async () => {
  const calls = mockFetch(() => htmlResponse('nope'));
  const noKey = await call('/catalog/movie/vimeus-movies.json');
  assert.deepEqual(await noKey.json(), { metas: [] });
  assert.equal(noKey.headers.get('X-Proxy-Error'), 'missing-api-key');
  const unknown = await worker.fetch(new Request(`${WORKER_URL}/catalog/movie/otro.json`), { VIMEUS_API_KEY: 'k' }, {});
  assert.equal(unknown.status, 404);
  const wrongType = await worker.fetch(new Request(`${WORKER_URL}/catalog/movie/vimeus-series.json`), { VIMEUS_API_KEY: 'k' }, {});
  assert.equal(wrongType.status, 404);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// /proxy — pasarela HLS
// ---------------------------------------------------------------------------
test('/proxy: reescribe un playlist hacia el propio Worker con cabeceras Vimeus', async () => {
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
  assert.ok(!body.includes('provider='), 'ya no se propaga el parámetro provider');

  // El proxy inyecta Referer/UA de Vimeus al pedir al CDN.
  assert.equal(calls[0].init.headers.Referer, 'https://vimeus.com/');
  assert.equal(calls[0].init.headers.Origin, 'https://vimeus.com');
  assert.match(calls[0].init.headers['User-Agent'], /^Mozilla\/5\.0/);
});

test('/proxy: respeta VIMEUS_REFERER e ignora un ?provider= heredado', async () => {
  const playlist = ['#EXTM3U', '#EXTINF:4.0,', 'seg0.ts', '#EXT-X-ENDLIST'].join('\n');
  const calls = mockFetch((url, init) => {
    assert.equal(url, 'https://cdn.vimeus.test/master.m3u8');
    assert.equal(init.headers.Referer, 'https://allowed.example/');
    return new Response(playlist, {
      status: 200,
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
    });
  });

  const res = await worker.fetch(
    new Request(`${WORKER_URL}/proxy?url=${encodeURIComponent('https://cdn.vimeus.test/master.m3u8')}&provider=unlimplay`),
    { VIMEUS_REFERER: 'https://allowed.example/' },
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes(`${WORKER_URL}/proxy?url=https%3A%2F%2Fcdn.vimeus.test%2Fseg0.ts`));
  assert.equal(calls.length, 1);
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

test('/proxy: funciona aunque falte la view_key (sólo necesita Referer/UA)', async () => {
  mockFetch(() => new Response(new Uint8Array([9]), { status: 200, headers: { 'Content-Type': 'video/mp2t' } }));
  const res = await worker.fetch(
    new Request(`${WORKER_URL}/proxy?url=${encodeURIComponent('https://cdn.example.net/s/seg1.ts')}`),
    { VIMEUS_VIEW_KEY: '' },
    {},
  );
  assert.equal(res.status, 200);
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
  assert.equal(new URL(calls[0].url).searchParams.get('imdb'), 'TT9999999');
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
  assert.match(html, /Vimeus HLS/);
  assert.ok(!/UnlimPlay/.test(html), 'la consola no menciona proveedores retirados');
  assert.ok(html.includes(`${WORKER_URL}/manifest.json`), 'debe mostrar la URL de instalación');
  assert.ok(!html.includes(VIEW_KEY), 'la consola no expone la view_key');
  assert.match(html, /<input id="mid"/);
  assert.match(html, /X-Proxy-Detail/);
});

test('raíz sin view_key: la consola avisa de que falta configurarla', async () => {
  const res = await worker.fetch(
    new Request(`${WORKER_URL}/`, { headers: { Accept: 'text/html' } }),
    { VIMEUS_VIEW_KEY: '' },
    {},
  );
  const html = await res.text();
  assert.match(html, /no configurada/);
});

test('raíz con Accept: application/json → healthcheck JSON', async () => {
  const res = await call('/', { headers: { Accept: 'application/json' } });
  assert.match(res.headers.get('Content-Type'), /application\/json/);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.source, 'https://vimeus.com');
});

test('/index.json siempre devuelve JSON aunque se pida HTML', async () => {
  const res = await call('/index.json', { headers: { Accept: 'text/html' } });
  assert.match(res.headers.get('Content-Type'), /application\/json/);
  assert.equal((await res.json()).status, 'ok');
});

test('VIMEUS_ORIGIN por env se refleja en el manifiesto y en el embed', async () => {
  const calls = mockFetch(() => htmlResponse(EMBED_HTML));
  const env = { VIMEUS_ORIGIN: 'https://mirror.example.org/' };

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
  assert.equal(new URL(calls[0].url).origin, 'https://mirror.example.org');
  assert.equal(streams[0].behaviorHints.requestHeaders.Referer, 'https://mirror.example.org/');
});
