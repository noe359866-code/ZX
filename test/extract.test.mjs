/**
 * Pruebas unitarias de la lógica pura del Worker (sin red).
 * Ejecutar con:  npm test   (Node ≥ 18, usa node:test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanId,
  normalizeSource,
  absolutize,
  extractM3u8Urls,
  findConfigUrls,
  rewritePlaylist,
  buildManifest,
} from '../src/index.js';

const BASE = 'https://unlimplay.com/f/embed/movie/tt1234567';

// ---------------------------------------------------------------------------
// cleanId
// ---------------------------------------------------------------------------
test('cleanId: quita .json y prefijos', () => {
  assert.equal(cleanId('tt1234567.json'), 'tt1234567');
  assert.equal(cleanId('tt1234567'), 'tt1234567');
  assert.equal(cleanId('tmdb:1234'), '1234');
  assert.equal(cleanId('tmdb:movie:1234'), '1234');
  assert.equal(cleanId('imdb:tt999'), 'tt999');
  assert.equal(cleanId('TMDB:MOVIE:550.json'), '550');
  assert.equal(cleanId('  tmdb:550  '), '550');
});

test('cleanId: rechaza entradas inválidas', () => {
  assert.equal(cleanId(''), '');
  assert.equal(cleanId(undefined), '');
  assert.equal(cleanId('null'), 'null'); // literal "null" sigue siendo alfanumérico
  assert.equal(cleanId('../../etc/passwd'), 'etc'); // se sanea a token seguro
  assert.equal(cleanId('https://x.com/y'), 'https');
});

// ---------------------------------------------------------------------------
// normalizeSource
// ---------------------------------------------------------------------------
test('normalizeSource: des-escapa diagonales invertidas y entidades', () => {
  const { clean } = normalizeSource('file:"https:\\/\\/cdn.example.com\\/hls\\/a\\/master.m3u8"');
  assert.match(clean, /https:\/\/cdn\.example\.com\/hls\/a\/master\.m3u8/);
  assert.ok(!clean.includes('\\/'));
});

test('normalizeSource: variantes unicode, hex y entidades HTML', () => {
  const { clean } = normalizeSource(
    'a\\u002Fb &#47;c &sol;d \\x2Fe &#x2F;f &amp;g \\u0026h',
  );
  assert.equal(clean, 'a/b /c /d /e /f &g &h');
});

test('normalizeSource: doble escape JS y entidades HTML de URL', () => {
  const { clean } = normalizeSource(String.raw`https\u003A\u002F\u002Fcdn.example.net\u002Fhls\u002Em3u8&quest;token&equals;x`);
  assert.equal(clean, 'https://cdn.example.net/hls.m3u8?token=x');
});

test('normalizeSource: une concatenaciones JS en la variante flat', () => {
  const { clean, flat } = normalizeSource('var u = "https://cdn.example.com/h/" + "master.m3u8";');
  assert.ok(!/cdn\.example\.com\/h\/master\.m3u8/.test(clean));
  assert.match(flat, /https:\/\/cdn\.example\.com\/h\/master\.m3u8/);
});

// ---------------------------------------------------------------------------
// absolutize
// ---------------------------------------------------------------------------
test('absolutize: resuelve relativas y protocol-relative', () => {
  assert.equal(absolutize('//cdn.example.com/a.m3u8', BASE), 'https://cdn.example.com/a.m3u8');
  assert.equal(absolutize('/hls/a.m3u8', BASE), 'https://unlimplay.com/hls/a.m3u8');
  assert.equal(
    absolutize('a.m3u8', 'https://cdn.example.com/hls/index.html'),
    'https://cdn.example.com/hls/a.m3u8',
  );
  assert.equal(absolutize('https://cdn.example.com/a.m3u8",', BASE), 'https://cdn.example.com/a.m3u8');
  assert.equal(absolutize('', BASE), null);
  assert.equal(absolutize('javascript:alert(1)', BASE), null);
});

// ---------------------------------------------------------------------------
// extractM3u8Urls — los patrones reales de los reproductores embebidos
// ---------------------------------------------------------------------------
const FIXTURES = {
  jwplayer: `
    <script>
      jwplayer("player").setup({
        sources: [{ file: "https:\\/\\/cdn.unlimplay.com\\/hls\\/tt1234567\\/master.m3u8?token=abc123",
                    type: "application/x-mpegURL" }],
        image: "/poster.jpg"
      });
    </script>`,

  plyr: `<div id="player" data-source='{"sources":[{"src":"//cdn2.unlimplay.video/v/abc/index.m3u8","type":"application/x-mpegURL"}]}'></div>`,

  videojs: `<script>player.src({ src: "https://cdn3.example.net/stream/tt1234567/playlist.m3u8", type: "application/x-mpegURL" });</script>`,

  hlsjs: `<script>var hlsUrl = 'https://cdn4.example.net/live/chunklist_w123.m3u8?sign=deadbeef';
          hls.loadSource(hlsUrl);</script>`,

  concatenated: `<script>var base = "https://cdn5.example.net/hls/tt1234567/";
                 var file = base + "master.m3u8" + "?expire=1700000000";
                 player.setup({ sources: [{ file: file }] });</script>`,

  inlineConcat: `<script>hls.loadSource("https://cdn9.example.net/vod/" + "index.m3u8");</script>`,

  minifiedJson: `<script>window.__CFG__={"player":{"file":"https:\\/\\/cdn6.example.net\\/v.m3u8"}};</script>`,

  unquoted: `source: https://cdn7.example.net/raw/master.m3u8?t=1 ,type: 'hls'`,

  entities: `<video data-src="https:&#47;&#47;cdn8.example.net&#47;a&#47;master.m3u8"></video>`,

  empty: `<html><body><iframe src="/player/other"></iframe></body></html>`,
};

test('extract: JWPlayer con file escapado (\\/)', () => {
  const urls = extractM3u8Urls(FIXTURES.jwplayer, BASE);
  assert.equal(urls.length, 1);
  assert.equal(urls[0], 'https://cdn.unlimplay.com/hls/tt1234567/master.m3u8?token=abc123');
});

test('extract: Plyr con URL protocol-relative', () => {
  const urls = extractM3u8Urls(FIXTURES.plyr, BASE);
  assert.deepEqual(urls, ['https://cdn2.unlimplay.video/v/abc/index.m3u8']);
});

test('extract: Video.js con src entre comillas', () => {
  const urls = extractM3u8Urls(FIXTURES.videojs, BASE);
  assert.equal(urls[0], 'https://cdn3.example.net/stream/tt1234567/playlist.m3u8');
});

test('extract: hls.js con variable simple', () => {
  const urls = extractM3u8Urls(FIXTURES.hlsjs, BASE);
  assert.ok(urls.includes('https://cdn4.example.net/live/chunklist_w123.m3u8?sign=deadbeef'));
});

test('extract: URL construida por concatenación de variables (patrón D)', () => {
  const urls = extractM3u8Urls(FIXTURES.concatenated, BASE);
  assert.ok(
    urls.some((u) => u.startsWith('https://cdn5.example.net/hls/tt1234567/master.m3u8')),
    `no se encontró la URL concatenada en ${JSON.stringify(urls)}`,
  );
  assert.ok(
    urls.some((u) => u.includes('?expire=1700000000')),
    'debe reconstruir también el token pegado por concatenación',
  );
});

test('extract: concatenación inline en una sola expresión', () => {
  const urls = extractM3u8Urls(FIXTURES.inlineConcat, BASE);
  assert.deepEqual(urls, ['https://cdn9.example.net/vod/index.m3u8']);
});

test('extract: JSON minificado con escapes dobles', () => {
  const urls = extractM3u8Urls(FIXTURES.minifiedJson, BASE);
  assert.deepEqual(urls, ['https://cdn6.example.net/v.m3u8']);
});

test('extract: URL sin comillas', () => {
  const urls = extractM3u8Urls(FIXTURES.unquoted, BASE);
  assert.ok(urls.includes('https://cdn7.example.net/raw/master.m3u8?t=1'));
});

test('extract: entidades HTML &#47;', () => {
  const urls = extractM3u8Urls(FIXTURES.entities, BASE);
  assert.deepEqual(urls, ['https://cdn8.example.net/a/master.m3u8']);
});

test('extract: URL con caracteres JS Unicode y entidades nombradas', () => {
  const source = String.raw`player.src("https\\u003A\\u002F\\u002Fcdn10.example.net\\u002Fhls\\u002Fmaster\\u002Em3u8?token\\u003Dx")`;
  assert.deepEqual(extractM3u8Urls(source, BASE), [
    'https://cdn10.example.net/hls/master.m3u8?token=x',
  ]);
});

test('extract: URL Base64 y doble percent-encoding', () => {
  const encoded = Buffer.from('https://cdn11.example.net/hls/master.m3u8?token=x').toString('base64');
  const base64 = extractM3u8Urls(`<script>const video = "${encoded}";</script>`, BASE);
  assert.deepEqual(base64, ['https://cdn11.example.net/hls/master.m3u8?token=x']);

  const percent = extractM3u8Urls(
    '<iframe src="/player?source=https%253A%252F%252Fcdn12.example.net%252Fhls%252Fmaster.m3u8%253Ftoken%253Dx"></iframe>',
    BASE,
  );
  assert.deepEqual(percent, ['https://cdn12.example.net/hls/master.m3u8?token=x']);
});

test('extract: source con ruta HLS relativa explícita', () => {
  assert.deepEqual(
    extractM3u8Urls('<video><source src="/hls/master.m3u8?token=x"></video>', BASE),
    ['https://unlimplay.com/hls/master.m3u8?token=x'],
  );
});

test('extract: sin .m3u8 devuelve array vacío', () => {
  assert.deepEqual(extractM3u8Urls(FIXTURES.empty, BASE), []);
  assert.deepEqual(extractM3u8Urls('', BASE), []);
  assert.deepEqual(extractM3u8Urls(null, BASE), []);
});

test('extract: deduplica y ordena por confianza', () => {
  // Nota: URL.toString() normaliza el host a minúsculas, así que los fixtures
  // ya usan hosts en minúsculas para que la comparación sea exacta.
  const html = `
    <script>var low = "https://cdn-a.example.net/whatever.m3u8";</script>
    <script>player.setup({ file: "https://cdn-b.example.net/master.m3u8?token=x" });</script>
    <p>https://cdn-a.example.net/whatever.m3u8</p>`;
  const urls = extractM3u8Urls(html, BASE);
  assert.equal(urls.length, 2, 'debe deduplicar la URL repetida');
  assert.equal(urls[0], 'https://cdn-b.example.net/master.m3u8?token=x');
  assert.equal(urls[1], 'https://cdn-a.example.net/whatever.m3u8');
});

test('extract: no acepta .m3u8 dentro de una ruta mayor (falso positivo)', () => {
  const urls = extractM3u8Urls('var x = "https://cdn.example.net/a.m3u8backup/file.bin";', BASE);
  assert.deepEqual(urls, []);
});

test('extract: ignora URLs relativas inválidas y protocolos raros', () => {
  assert.deepEqual(extractM3u8Urls('file: "ftp://cdn.example.net/a.m3u8"', BASE), []);
  assert.deepEqual(extractM3u8Urls('src: rtsp://cdn.example.net/a.m3u8', BASE), []);
  assert.deepEqual(extractM3u8Urls('<a href="/sin-esquema.m3u8">x</a>', BASE), []);
});

test('extract: acepta http/https en las tres formas', () => {
  const html = `a: https://cdn-1.example.net/1.m3u8 | b: "http://cdn-2.example.net/2.m3u8" | c: //cdn-3.example.net/3.m3u8`;
  const urls = extractM3u8Urls(html, BASE);
  assert.ok(urls.includes('https://cdn-1.example.net/1.m3u8'));
  assert.ok(urls.includes('http://cdn-2.example.net/2.m3u8'));
  assert.ok(urls.includes('https://cdn-3.example.net/3.m3u8'));
});

// ---------------------------------------------------------------------------
// findConfigUrls (deep scan)
// ---------------------------------------------------------------------------
test('findConfigUrls: detecta endpoints de API y descarta estáticos', () => {
  const html = `
    <script src="/assets/player.js"></script>
    <img src="/logo.png">
    <script>fetch("/api/source/tt1234567").then(...)</script>
    <script>var cfg = "https://api.example.net/player/config.php?id=tt1234567";</script>`;
  const urls = findConfigUrls(html, BASE);
  assert.ok(urls.includes('https://unlimplay.com/api/source/tt1234567'));
  assert.ok(urls.includes('https://api.example.net/player/config.php?id=tt1234567'));
  assert.ok(urls.includes('https://unlimplay.com/assets/player.js'));
  assert.ok(!urls.some((u) => u.endsWith('logo.png')));
});

test('findConfigUrls: sigue iframes de players públicos y bloquea IP local externa', () => {
  const html = '<iframe src="https://player.example.net/embed/abc"></iframe><iframe src="http://127.0.0.1/admin"></iframe>';
  const urls = findConfigUrls(html, BASE);
  assert.ok(urls.includes('https://player.example.net/embed/abc'));
  assert.ok(!urls.some((url) => url.includes('127.0.0.1')));

  // El origen local propio sí se permite para el mock de desarrollo.
  const local = findConfigUrls('<script>fetch("/api/source/tt1")</script>', 'http://127.0.0.1:8788/f/embed/movie/tt1');
  assert.deepEqual(local, ['http://127.0.0.1:8788/api/source/tt1']);
});

test('findConfigUrls: sin candidatos devuelve vacío', () => {
  assert.deepEqual(findConfigUrls('<html></html>', BASE), []);
});

// ---------------------------------------------------------------------------
// rewritePlaylist (modo proxy HLS)
// ---------------------------------------------------------------------------
test('rewritePlaylist: proxifica variantes, segmentos y claves', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.php?k=1"',
    '#EXTINF:6.0,',
    'seg0.ts',
    '/hls/tt1/seg1.ts',
    'https://cdn.example.net/hls/tt1/seg2.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');

  const out = rewritePlaylist(playlist, 'https://cdn.example.net/hls/tt1/index.m3u8', 'https://w.dev');

  assert.ok(out.startsWith('#EXTM3U'));
  assert.ok(
    out.includes('URI="https://w.dev/proxy?url=https%3A%2F%2Fcdn.example.net%2Fhls%2Ftt1%2Fkey.php%3Fk%3D1"'),
  );
  assert.ok(out.includes('https://w.dev/proxy?url=https%3A%2F%2Fcdn.example.net%2Fhls%2Ftt1%2Fseg0.ts'));
  assert.ok(out.includes('https://w.dev/proxy?url=https%3A%2F%2Fcdn.example.net%2Fhls%2Ftt1%2Fseg1.ts'));
  assert.ok(out.includes('https://w.dev/proxy?url=https%3A%2F%2Fcdn.example.net%2Fhls%2Ftt1%2Fseg2.ts'));
  assert.ok(out.includes('#EXT-X-ENDLIST'));
  assert.ok(out.includes('#EXTINF:6.0,'));
});

test('rewritePlaylist: master con variantes absolutas', () => {
  const master = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080', '1080p.m3u8'].join('\n');
  const out = rewritePlaylist(master, 'https://cdn.example.net/m.m3u8', 'https://w.dev');
  assert.ok(out.includes('https://w.dev/proxy?url=https%3A%2F%2Fcdn.example.net%2F1080p.m3u8'));
});

// ---------------------------------------------------------------------------
// buildManifest
// ---------------------------------------------------------------------------
test('buildManifest: cumple el contrato de Stremio', () => {
  const m = buildManifest();
  assert.equal(m.id, 'com.cf.unlimplay.proxy');
  assert.equal(m.name, 'UnlimPlay Proxy Stream');
  assert.deepEqual(m.resources, ['stream']);
  assert.deepEqual(m.types, ['movie', 'series']);
  assert.deepEqual(m.idPrefixes, ['tt', 'tmdb:']);
  assert.ok(m.version && m.description);
});

test('extract: el patrón D no inventa URLs con bases que son sólo la raíz', () => {
  const html = '<script>var h = "https://unlimplay.com/"; var f = "master.m3u8";</script>';
  assert.deepEqual(extractM3u8Urls(html, BASE), []);
});

// ---------------------------------------------------------------------------
// truncateSmart
// ---------------------------------------------------------------------------
test('truncateSmart: conserva cabeza y cola en documentos grandes', async () => {
  const { truncateSmart } = await import('../src/index.js');
  const head = 'HEAD'.repeat(10);
  const tail = '<script>file:"https://cdn.example.net/tail.m3u8"</script>';
  const middle = 'x'.repeat(10_000);
  const out = truncateSmart(`${head}${middle}${tail}`, 1000);
  assert.ok(out.length < 1200, 'debe recortar');
  assert.ok(out.startsWith(head), 'conserva la cabeza');
  assert.ok(out.endsWith(tail), 'conserva la cola');
  assert.deepEqual(extractM3u8Urls(out, BASE), ['https://cdn.example.net/tail.m3u8']);
});

test('truncateSmart: no modifica documentos pequeños', async () => {
  const { truncateSmart } = await import('../src/index.js');
  assert.equal(truncateSmart('abc', 1000), 'abc');
  assert.equal(truncateSmart('', 1000), '');
  assert.equal(truncateSmart(null, 1000), '');
});

// ---------------------------------------------------------------------------
// resolveSource (origen configurable por env)
// ---------------------------------------------------------------------------
test('resolveSource: valores por defecto exigidos por el addon', async () => {
  const { resolveSource } = await import('../src/index.js');
  const s = resolveSource({});
  assert.equal(s.origin, 'https://unlimplay.com');
  assert.equal(s.referer, 'https://unlimplay.com/');
  assert.equal(s.embedUrl('tt1234567'), 'https://unlimplay.com/f/embed/movie/tt1234567');
  assert.equal(s.tvEmbedPath, '/f/embed/tv/');
  assert.equal(s.embedUrlFor('series', 'tt0903747', 1, 2), 'https://unlimplay.com/f/embed/tv/tt0903747/1/2');
});

test('resolveSource: sobrescribible por variables de entorno', async () => {
  const { resolveSource } = await import('../src/index.js');
  const s = resolveSource({
    SOURCE_ORIGIN: 'https://mirror.example.org/',
    EMBED_PATH: 'embed/movie',
    TV_EMBED_PATH: 'embed/tv',
  });
  assert.equal(s.origin, 'https://mirror.example.org');
  assert.equal(s.referer, 'https://mirror.example.org/');
  assert.equal(s.embedUrl('tt1'), 'https://mirror.example.org/embed/movie/tt1');
  assert.equal(s.embedUrl('a b'), 'https://mirror.example.org/embed/movie/a%20b');
  assert.equal(s.embedUrlFor('series', 'tt1', 2, 4), 'https://mirror.example.org/embed/tv/tt1/2/4');
});
