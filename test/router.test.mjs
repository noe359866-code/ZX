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
  assert.deepEqual(calls.map((c) => new URL(c.url).pathname), [
    '/e/serie', '/expired.m3u8', '/e/anime', '/valid.m3u8',
  ]);
});

test('series: traduce id:temporada:episodio con IMDb a /e/serie', async () => {
  const calls = mockFetch((url) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/e/serie');
    assert.equal(parsed.searchParams.get('imdb'), 'tt0903747');
    assert.equal(parsed.searchParams.get('se'), '1');
    assert.equal(parsed.searchParams.get('ep'), '2');
    return htmlResponse('<script>player.setup({file:"https://cdn.example.net/episode.m3u8"})</script>');
  });

  const res = await call('/stream/series/tt0903747:1:2.json');
  const { streams } = await res.json();
  assert.equal(streams.length, 1);
  assert.equal(calls.length, 1);
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

  const invalid = await call('/stream/series/tt0903747.json');
  assert.deepEqual(await invalid.json(), { streams: [] });
  assert.equal(invalid.headers.get('X-Proxy-Error'), 'bad-id');
  assert.equal(calls.length, 1, 'no consulta el origen para un episodio incompleto');
});

test('los diagnósticos no filtran el view_key de un error Vimeus', async () => {
  const secret = 'private-view-key-value';
  mockFetch(() => new Response('no autorizado', { status: 403 }));
  const res = await worker.fetch(
    new Request(`${WORKER_URL}/stream/movie/tt1234567.json`),
    { VIMEUS_VIEW_KEY: secret },
    {},
  );
  const detail = res.headers.get('X-Proxy-Detail') || '';
  assert.equal(res.headers.get('X-Proxy-Error'), 'upstream');
  assert.match(detail, /403/);
  assert.ok(!detail.includes(secret));
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
