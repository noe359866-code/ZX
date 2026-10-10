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
  resolveVimeusSource,
  resolveSource,
  unpackPackedJs,
  isHlsUrl,
  describePlaylist,
  listingItemToMeta,
  listingPageFromSkip,
} from '../src/index.js';

const BASE = 'https://vimeus.com/e/movie?imdb=tt1234567&view_key=test-key';

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
  assert.equal(absolutize('/hls/a.m3u8', BASE), 'https://vimeus.com/hls/a.m3u8');
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
        sources: [{ file: "https:\\/\\/cdn.vimeus.test\\/hls\\/tt1234567\\/master.m3u8?token=abc123",
                    type: "application/x-mpegURL" }],
        image: "/poster.jpg"
      });
    </script>`,

  plyr: `<div id="player" data-source='{"sources":[{"src":"//cdn2.vimeus.test/v/abc/index.m3u8","type":"application/x-mpegURL"}]}'></div>`,

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
  assert.equal(urls[0], 'https://cdn.vimeus.test/hls/tt1234567/master.m3u8?token=abc123');
});

test('extract: Plyr con URL protocol-relative', () => {
  const urls = extractM3u8Urls(FIXTURES.plyr, BASE);
  assert.deepEqual(urls, ['https://cdn2.vimeus.test/v/abc/index.m3u8']);
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
    ['https://vimeus.com/hls/master.m3u8?token=x'],
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
  assert.ok(urls.includes('https://vimeus.com/api/source/tt1234567'));
  assert.ok(urls.includes('https://api.example.net/player/config.php?id=tt1234567'));
  assert.ok(urls.includes('https://vimeus.com/assets/player.js'));
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
  assert.ok(!out.includes('provider='), 'ya no se añade el parámetro provider');
});

test('rewritePlaylist: propaga ref= a variantes, segmentos y claves', () => {
  const playlist = ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="key.php"', '#EXTINF:6.0,', 'seg0.ts'].join('\n');
  const out = rewritePlaylist(playlist, 'https://cdn.example.net/hls/index.m3u8', 'https://w.dev', 'https://host.example');
  assert.ok(out.includes('URI="https://w.dev/proxy?url=https%3A%2F%2Fcdn.example.net%2Fhls%2Fkey.php&ref=https%3A%2F%2Fhost.example"'));
  assert.ok(out.includes('https://w.dev/proxy?url=https%3A%2F%2Fcdn.example.net%2Fhls%2Fseg0.ts&ref=https%3A%2F%2Fhost.example'));
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
  assert.equal(m.name, 'Vimeus HLS');
  assert.equal(m.logo, 'https://vimeus.com/favicon.ico');
  assert.deepEqual(m.resources, ['stream']);
  assert.deepEqual(m.types, ['movie', 'series']);
  assert.deepEqual(m.idPrefixes, ['tt', 'tmdb:']);
  assert.ok(m.version && m.description);
});

test('extract: el patrón D no inventa URLs con bases que son sólo la raíz', () => {
  const html = '<script>var h = "https://vimeus.com/"; var f = "master.m3u8";</script>';
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
// Proveedores
// ---------------------------------------------------------------------------
test('resolveVimeusSource: construye embeds IMDb/TMDb con view_key', () => {
  const source = resolveVimeusSource({ VIMEUS_VIEW_KEY: 'test-key' });
  assert.equal(source.origin, 'https://vimeus.com');

  const movie = new URL(source.embedUrlsFor('movie', 'tt0133093')[0]);
  assert.equal(movie.pathname, '/e/movie');
  assert.equal(movie.searchParams.get('imdb'), 'tt0133093');
  assert.equal(movie.searchParams.get('view_key'), 'test-key');

  const series = source.embedUrlsFor('series', '1429', 2, 3).map((value) => new URL(value));
  assert.deepEqual(series.map((url) => url.pathname), ['/e/serie', '/e/anime']);
  for (const url of series) {
    assert.equal(url.searchParams.get('tmdb'), '1429');
    assert.equal(url.searchParams.get('se'), '2');
    assert.equal(url.searchParams.get('ep'), '3');
    assert.equal(url.searchParams.get('view_key'), 'test-key');
  }
});

test('resolveVimeusSource: sin clave no crea una URL de embed', () => {
  const source = resolveVimeusSource({});
  assert.equal(source.viewKey, '');
  assert.deepEqual(source.embedUrlsFor('movie', 'tt123'), []);
});

test('resolveVimeusSource: valores por defecto y alias resolveSource', () => {
  const source = resolveVimeusSource({});
  assert.equal(source.key, 'vimeus');
  assert.equal(source.name, 'Vimeus');
  assert.equal(source.origin, 'https://vimeus.com');
  assert.equal(source.referer, 'https://vimeus.com/');
  assert.equal(source.moviePath, '/e/movie');
  assert.deepEqual(source.seriesPaths, ['/e/serie', '/e/anime']);
  assert.equal(resolveSource, resolveVimeusSource);
});

test('resolveVimeusSource: sobrescribible por variables de entorno', () => {
  const source = resolveVimeusSource({
    VIMEUS_ORIGIN: 'https://mirror.example.org/',
    VIMEUS_REFERER: 'https://allowed.example/',
    VIMEUS_MOVIE_PATH: 'embed/film',
    VIMEUS_SERIES_PATHS: '/embed/show, /embed/anime',
    VIEW_KEY: 'legacy',
  });
  assert.equal(source.origin, 'https://mirror.example.org');
  assert.equal(source.referer, 'https://allowed.example/');
  assert.equal(source.viewKey, 'legacy');

  const movie = new URL(source.embedUrlsFor('movie', 'a b')[0]);
  assert.equal(movie.origin, 'https://mirror.example.org');
  assert.equal(movie.pathname, '/embed/film');
  assert.equal(movie.searchParams.get('tmdb'), 'a b');

  const series = source.embedUrlsFor('series', 'tt1', 2, 4).map((value) => new URL(value));
  assert.deepEqual(series.map((url) => url.pathname), ['/embed/show', '/embed/anime']);
  assert.throws(() => source.embedUrlsFor('series', 'tt1', 1, 0), /temporada y episodio/);
});

// ---------------------------------------------------------------------------
// Extractor: ofuscaciones y HLS sin extensión
// ---------------------------------------------------------------------------

/** Empaquetador p.a.c.k.e.r fiel al original (sólo para generar fixtures). */
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

const PACKED_SOURCE =
  'var player=jwplayer("vplayer");player.setup({sources:[{file:"https://cdn-packed.example.net/hls/abc123/master.m3u8?token=p4ck3d",type:"hls"}],image:"/poster.jpg"});';

test('unpackPackedJs: desempaqueta p.a.c.k.e.r en base 62 y 36', () => {
  for (const radix of [62, 36]) {
    const unpacked = unpackPackedJs(`<script>${packJs(PACKED_SOURCE, radix)}</script>`);
    assert.ok(unpacked.includes('cdn-packed.example.net/hls/abc123/master.m3u8?token=p4ck3d'), `radix ${radix}`);
  }
  assert.equal(unpackPackedJs('<script>var a = 1;</script>'), '');
});

test('unpackPackedJs: resuelve bloques anidados', () => {
  const inner = packJs(PACKED_SOURCE);
  const outer = packJs(`document.write('${inner.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');`);
  assert.ok(unpackPackedJs(outer).includes('cdn-packed.example.net/hls/abc123/master.m3u8'));
});

test('extract: encuentra el .m3u8 dentro de un script empaquetado', () => {
  const html = `<html><body><div id="vplayer"></div><script>${packJs(PACKED_SOURCE)}</script></body></html>`;
  assert.deepEqual(extractM3u8Urls(html, BASE), [
    'https://cdn-packed.example.net/hls/abc123/master.m3u8?token=p4ck3d',
  ]);
});

test('extract: URL escrita al revés (split/reverse/join)', () => {
  const reversed = [...'https://cdn-rev.example.net/live/index.m3u8?sig=1'].reverse().join('');
  const html = `<script>var s="${reversed}".split("").reverse().join("");hls.loadSource(s);</script>`;
  assert.deepEqual(extractM3u8Urls(html, BASE), ['https://cdn-rev.example.net/live/index.m3u8?sig=1']);
});

test('extract: fuente HLS sin extensión identificada por type', () => {
  const js = `<script>p.setup({sources:[
    {src:"https://cdn-typed.example.net/vod/12345/stream",type:"application/x-mpegURL"},
    {src:"https://cdn-typed.example.net/vod/12345.mp4",type:"video/mp4"}
  ]})</script>`;
  assert.deepEqual(extractM3u8Urls(js, BASE), ['https://cdn-typed.example.net/vod/12345/stream']);

  const html = '<video><source type="application/vnd.apple.mpegurl" src="/hls/live/manifest"></video>';
  assert.deepEqual(extractM3u8Urls(html, BASE), ['https://vimeus.com/hls/live/manifest']);

  const typeFirst = '<script>var cfg={type:"hls",file:"https://cdn-typed.example.net/x/playlist"}</script>';
  assert.deepEqual(extractM3u8Urls(typeFirst, BASE), ['https://cdn-typed.example.net/x/playlist']);
});

test('extract: HLS seleccionado por query o formato Azure', () => {
  const html = `<script>
    var a="https://cdn-q.example.net/manifest?format=m3u8";
    var b="https://ams.example.net/x/manifest(format=m3u8-aapl)";
    var c="https://cdn-q.example.net/manifest?format=mp4";
    var d="https://cdn-q.example.net/p?type=hls";
  </script>`;
  const urls = extractM3u8Urls(html, BASE);
  assert.ok(urls.includes('https://cdn-q.example.net/manifest?format=m3u8'));
  assert.ok(urls.includes('https://ams.example.net/x/manifest(format=m3u8-aapl)'));
  assert.ok(urls.includes('https://cdn-q.example.net/p?type=hls'));
  assert.ok(!urls.some((u) => u.includes('format=mp4')));
});

test('extract: trailers/previews quedan por detrás de la película', () => {
  const html = `<script>
    a({file:"https://cdn.example.net/preview/trailer.m3u8"});
    b({file:"https://cdn.example.net/movie/master.m3u8"});
  </script>`;
  assert.deepEqual(extractM3u8Urls(html, BASE), [
    'https://cdn.example.net/movie/master.m3u8',
    'https://cdn.example.net/preview/trailer.m3u8',
  ]);
});

test('isHlsUrl: extensiones, rutas intermedias, query y envoltorios', () => {
  assert.equal(isHlsUrl('https://a.b/x.m3u8'), true);
  assert.equal(isHlsUrl('https://a.b/x.M3U8?t=1'), true);
  assert.equal(isHlsUrl('https://a.b/x.m3u'), true);
  assert.equal(isHlsUrl('https://a.b/x.m3u8/segment'), true);
  assert.equal(isHlsUrl('https://a.b/manifest(format=m3u8-aapl)'), true);
  assert.equal(isHlsUrl('https://a.b/p?type=hls'), true);
  assert.equal(isHlsUrl('https://a.b/p?file=master.m3u8'), true);
  assert.equal(isHlsUrl('https://a.b/p?type=hlsx'), false);
  assert.equal(isHlsUrl('https://a.b/player?source=https://c.d/x.m3u8'), false, 'envoltorio de otra URL');
  assert.equal(isHlsUrl('https://a.b/player?src=https%3A%2F%2Fc.d%2Fx.m3u8'), false);
  assert.equal(isHlsUrl('https://a.b/video.mp4'), false);
  assert.equal(isHlsUrl('ftp://a.b/video.m3u8'), false);
});

test('absolutize: conserva un ")" que cierra un "(" de la URL', () => {
  assert.equal(absolutize('https://a.b/x/manifest(format=m3u8-aapl)', BASE), 'https://a.b/x/manifest(format=m3u8-aapl)');
  assert.equal(absolutize('https://a.b/x/master.m3u8)', BASE), 'https://a.b/x/master.m3u8');
  assert.equal(absolutize('https://a.b/x/master.m3u8").', BASE), 'https://a.b/x/master.m3u8');
});

test('findConfigUrls: sigue meta refresh y location.href', () => {
  const html = `<meta http-equiv="refresh" content="0;url=/player/real?id=1">
    <script>window.location.href = "https://player.example.net/v/abc";</script>
    <script>top.location.replace('/go/next');</script>`;
  const urls = findConfigUrls(html, BASE);
  assert.equal(urls[0], 'https://vimeus.com/player/real?id=1');
  assert.ok(urls.includes('https://player.example.net/v/abc'));
  assert.ok(urls.includes('https://vimeus.com/go/next'));
});

test('findConfigUrls: lee URLs de API dentro de código empaquetado', () => {
  const packed = packJs('fetch("/api/source/tt777").then(function(r){return r.json()});');
  const urls = findConfigUrls(`<script>${packed}</script>`, BASE);
  assert.ok(urls.includes('https://vimeus.com/api/source/tt777'));
});

test('describePlaylist: calidad máxima, variantes y directo', () => {
  const master = ['#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720', '720.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080', '1080.m3u8'].join('\n');
  assert.deepEqual(describePlaylist(master), { quality: '1080p', variants: 2, live: false });
  assert.equal(describePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=3840x2160\nuhd.m3u8').quality, '4K');
  assert.deepEqual(describePlaylist('#EXTM3U\n#EXTINF:4,\nseg.ts\n'), { quality: '', variants: 0, live: true });
  assert.deepEqual(describePlaylist('#EXTM3U\n#EXTINF:4,\nseg.ts\n#EXT-X-ENDLIST'), { quality: '', variants: 0, live: false });
});

// ---------------------------------------------------------------------------
// API de listado → metas
// ---------------------------------------------------------------------------
test('listingItemToMeta: ids, imágenes y casos sin datos', () => {
  assert.deepEqual(listingItemToMeta({ tmdb_id: 550, imdb_id: 'TT0137523', title: 'Fight Club', poster: '/p.jpg', backdrop: 'b.jpg' }, 'movie'), {
    id: 'tt0137523', type: 'movie', name: 'Fight Club',
    poster: 'https://image.tmdb.org/t/p/w500/p.jpg', background: 'https://image.tmdb.org/t/p/w1280/b.jpg', posterShape: 'poster',
  });
  assert.equal(listingItemToMeta({ tmdb_id: '99861', imdb_id: null, title: 'X' }, 'movie').id, 'tmdb:99861');
  assert.equal(listingItemToMeta({ tmdb_id: 7, title: '', poster: 'https://cdn.example/p.png' }, 'series').poster, 'https://cdn.example/p.png');
  assert.equal(listingItemToMeta({ tmdb_id: 7, title: '' }, 'series').name, 'tmdb:7');
  assert.equal(listingItemToMeta({ tmdb_id: 0, imdb_id: 'nope' }, 'movie'), null);
  assert.equal(listingItemToMeta(null, 'movie'), null);
});

test('listingPageFromSkip: 50 por página', () => {
  assert.equal(listingPageFromSkip(undefined), 1);
  assert.equal(listingPageFromSkip('0'), 1);
  assert.equal(listingPageFromSkip('49'), 1);
  assert.equal(listingPageFromSkip('50'), 2);
  assert.equal(listingPageFromSkip('100'), 3);
  assert.equal(listingPageFromSkip('abc'), 1);
});
