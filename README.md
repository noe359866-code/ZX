# Vimeus HLS — Addon de Stremio en Cloudflare Workers

Worker ES Module que resuelve una URL HLS (`.m3u8`) para Stremio **exclusivamente desde Vimeus**. El Worker entrega a Stremio el enlace HLS encontrado, con las cabeceras necesarias; opcionalmente puede retransmitir la playlist y sus segmentos mediante `/proxy`.

```text
Stremio ──▶ /stream/movie/tt1234567.json ──▶ Worker
                                                   │  Vimeus /e/movie?imdb=tt1234567&view_key=…
                                                   │  extrae y valida el HLS
                                                   ▼
                                           { streams: [{ type: "hls", url: "…m3u8" }] }
```

> Configura una `VIMEUS_VIEW_KEY` autorizada como secreto del Worker. **Sin clave el addon no devuelve streams.** El resolver sólo analiza respuestas HTTP normales: no ejecuta JavaScript, no crea cookies y no inventa ni renueva tokens.

## Endpoints

| Método | Ruta | Descripción |
| --- | --- | --- |
| `GET` | `/manifest.json` | Manifiesto de Stremio. |
| `GET` | `/stream/movie/{id}.json` | Resuelve una película y devuelve el HLS. |
| `GET` | `/stream/series/{id}:{season}:{episode}.json` | Resuelve un episodio. |
| `GET` | `/catalog/{movie\|series}/{vimeus-movies\|vimeus-series\|vimeus-animes}[/skip=N].json` | Catálogos "Vimeus · Películas / Series / Anime" desde la API de listado. Requiere `VIMEUS_API_KEY`. |
| `GET` | `/proxy?url=<URL>[&ref=<origen>]` | Pasarela HLS opcional para playlists, variantes y segmentos. `ref` es el origen del host de terceros cuyo Referer espera el CDN. |
| `GET` | `/debug/{movie\|series}/{id}?token=…[&html=1]` | Traza completa del scraping (páginas visitadas, URLs descubiertas, candidatos, calidad). Requiere `DEBUG_TOKEN`. |
| `GET` | `/` | Healthcheck JSON; con `Accept: text/html`, consola de prueba. |
| `OPTIONS` | cualquier ruta | Preflight CORS. |

Las respuestas del addon incluyen CORS. Cuando hay un stream, `X-Stream-Provider: vimeus` y `X-Candidates-Found` resumen el resultado.

## Cómo funciona Vimeus (y cómo lo aprovecha el addon)

Comportamiento observado del servicio (octubre 2026):

- Vimeus **no aloja vídeo**: es un agregador que "scrapea embeds de múltiples fuentes" (Doodstream, Streamwish, Voe, etc.) y los sirve con un reproductor propio con **selector de servidores** y **dominios rotativos**. La página `/e/…` renderiza el título en servidor y carga el player/servidores por JavaScript.
- Consecuencia: el `.m3u8` **no está en la página de Vimeus**, sino 1–2 iframes más abajo, en el host de terceros. El **deep scan es la ruta normal**, no la excepción, y el `Referer` que valida el CDN del HLS es el de **ese host**, no el de Vimeus.
- `/e/movie`, `/e/serie` y `/e/anime` aceptan `tmdb=` o `imdb=` (+ `se`/`ep`). **`/e/serie` y `/e/anime` son catálogos disjuntos**: *Breaking Bad* sólo existe en `serie`, *One Piece* sólo en `anime`; el otro responde `404 Not Found` de inmediato.
- `view_key` ausente **o inválida** → `400 Bad Request: view_key is required.`; título inexistente → `404 Not Found`.
- La `view_key` se valida por **Referer** (`referrerpolicy="origin"` en el iframe): si en el dashboard restringes dominios, el Referer debe ser exactamente el origen autorizado.

Lo que hace el addon con eso:

1. Pide los embeds en **paralelo** (`/e/serie` + `/e/anime` para series) y descarta de inmediato los 404.
2. Extrae playlists de la página; si no hay, sigue iframes/APIs (en lotes de 2, hasta `MAX_DEEP_SCAN` páginas) **recordando en qué página apareció cada candidato**.
3. Verifica cada candidato con el `Referer`/`Origin` de **su** página y entrega esas mismas cabeceras a Stremio (`requestHeaders`/`proxyHeaders`). En modo proxy, el enlace lleva `ref=<origen>` para que el Worker aplique el Referer correcto a variantes y segmentos.
4. Clasifica el fallo sin trabajo inútil: `invalid-view-key` (400/401/403), `not-found` (404 en todas las rutas o sin playlist), `upstream` (red/HTTP/HLS caducado).

El ID `tt…` se envía como `imdb`; un ID numérico, como `tmdb`. En todos los casos se añade `view_key`; para series también `se` y `ep`.

El ID de Stremio puede ser `tt1234567`, `tmdb:550`, `tmdb:movie:550` o, para una serie, `tt0903747:1:2`. El Worker limpia prefijos/escapes y valida temporada y episodio antes de construir las URLs.

Ejemplo de respuesta:

```json
{
  "streams": [
    {
      "name": "Vimeus HLS",
      "title": "Vimeus [HLS · 1080p]",
      "type": "hls",
      "url": "https://cdn.example/master.m3u8?token=…",
      "behaviorHints": {
        "notSupported": false,
        "notWebReady": true,
        "requestHeaders": {
          "Referer": "https://vimeus.com/",
          "User-Agent": "Mozilla/5.0 …"
        },
        "proxyHeaders": {
          "request": {
            "Referer": "https://vimeus.com/",
            "User-Agent": "Mozilla/5.0 …",
            "Origin": "https://vimeus.com"
          }
        },
        "bingeGroup": "vimeus-0"
      }
    }
  ]
}
```

`PROXY_HLS=1` es útil para clientes que no pueden inyectar cabeceras, incluido Stremio Web: el enlace entregado a Stremio apunta a `/proxy`, y el Worker reescribe las playlists para que variantes y segmentos también pasen por él con el `Referer` de Vimeus.

Si no se encuentra HLS, se devuelve `200 {"streams": []}` para no romper Stremio. Los detalles van en `X-Proxy-Error` y `X-Proxy-Detail`:

| `X-Proxy-Error` | Significado |
| --- | --- |
| `missing-view-key` | No hay `VIMEUS_VIEW_KEY`; no se contacta con Vimeus. |
| `invalid-view-key` | Vimeus respondió 400 "view_key is required" (clave incorrecta) o 401/403 (Referer no autorizado). Revisa `VIMEUS_VIEW_KEY` y `VIMEUS_REFERER`. |
| `not-found` | 404 en todas las rutas (título fuera del catálogo) o embed sin ninguna playlist reconocible. |
| `upstream` | Error de red/HTTP, o la playlist encontrada no validó (caducada, HTML disfrazado). |
| `bad-id` | ID de Stremio no utilizable. |

Las claves `view_key` y los tokens se eliminan de los diagnósticos.

### Depurar un título concreto

```bash
npx wrangler secret put DEBUG_TOKEN        # elige un token largo
curl -s "https://TU-WORKER.workers.dev/debug/movie/tt2395427?token=TU_TOKEN&html=1" | jq
```

La respuesta lista cada página visitada (`embed` → `scan` → `verify`) con estado HTTP, URLs de configuración/iframes descubiertas, candidatos HLS, la página de origen de cada stream y su calidad. Con `html=1` incluye los primeros 24 KB del HTML de cada página (con secretos redactados): es la forma de ver qué devuelve realmente Vimeus y su host de terceros para afinar el extractor. Sin `DEBUG_TOKEN` el endpoint responde 404.

## Extracción HLS

El extractor normaliza el HTML/JS estático antes de aplicar patrones. Reconoce, entre otros casos:

- URLs JSON escapadas (`https:\/\/…`), escapes Unicode/hex y entidades HTML.
- URLs codificadas en porcentaje, incluso con doble codificación, y payloads Base64 comunes (también anidados).
- **Scripts empaquetados con p.a.c.k.e.r** (`eval(function(p,a,c,k,e,d){…})`), incluidos los anidados: se desempaquetan como texto, sin `eval`.
- **Cadenas invertidas** (`"8u3m.retsam/…".split("").reverse().join("")`).
- Configuraciones de reproductores (`file`, `src`, `source`, `hlsUrl`, `playlist`, etc.), rutas relativas, URLs entrecomilladas y URLs construidas por concatenación.
- **HLS sin extensión `.m3u8`**: fuentes con `type: "application/x-mpegURL"` / `"hls"`, URLs con `?format=m3u8` / `?type=hls`, `.m3u` y el formato Azure `manifest(format=m3u8-aapl)`.
- Redirecciones, playlists directas y referencias a iframes/configuración mediante un deep scan limitado, que también sigue `<meta http-equiv="refresh">` y `location.href = …`. Los endpoints de API (`/api/…`, `.json`, `.php`…) se piden con cabeceras XHR (`X-Requested-With`, `Accept: application/json`).

Los candidatos se absolutizan, validan como URLs HTTP(S) de playlist HLS, deduplican y ordenan por confianza (las URLs de `preview`/`trailer`/`ads` quedan al final). Con `VERIFY_HLS=1` cada candidato se solicita **en paralelo** con las cabeceras de Vimeus y se exige una respuesta `#EXTM3U`; de la master playlist verificada se extrae la resolución máxima para el título del stream (`Vimeus [HLS · 1080p]`, `4K`, `LIVE`). El análisis es estático: **no se ejecuta el player ni se eluden controles de acceso**. Un HLS que requiere sesión, DRM o tokens no expuestos no se puede resolver con este mecanismo.

`/proxy` retransmite el manifiesto y los segmentos con `Range`, CORS y cabeceras de Vimeus. La URL de destino debe ser HTTP(S) y no puede apuntar al propio Worker.

## Catálogos con la API de listado (opcional)

Vimeus ofrece una API de listado de servidor (`GET https://vimeus.com/api/listing/{movies|series|animes}`, cabecera `X-API-Key`, 50 elementos por página). Si configuras `VIMEUS_API_KEY` el addon:

- añade `catalog` a `resources` y publica tres catálogos en el manifiesto: **Vimeus · Películas** (`movie`), **Vimeus · Series** y **Vimeus · Anime** (ambos `series`), con paginación por `skip` (Stremio pide `skip=50`, `100`… y el addon lo traduce a `page=2`, `3`…);
- convierte cada elemento en un `meta` de Stremio: id IMDb (`tt…`) si existe, si no `tmdb:ID` (ambos los acepta `/stream`), póster `https://image.tmdb.org/t/p/w500` + ruta y fondo `w1280`;
- cachea cada página 5 minutos y, ante cualquier fallo, responde `{ "metas": [] }` con `X-Proxy-Error` (`invalid-api-key`, `upstream`) para no romper la interfaz. El fin de la paginación (404 "No content found" en Vimeus) devuelve una lista vacía sin error.

Sin `VIMEUS_API_KEY` el manifiesto no anuncia catálogos y `/catalog/...` responde `{ "metas": [] }` con `X-Proxy-Error: missing-api-key`. La API Key sólo viaja del Worker a Vimeus: nunca aparece en el manifiesto ni en las respuestas.

```bash
npx wrangler secret put VIMEUS_API_KEY
curl -s https://TU-WORKER.workers.dev/catalog/movie/vimeus-movies.json | head -c 600
curl -s https://TU-WORKER.workers.dev/catalog/series/vimeus-animes/skip=50.json | head -c 600
```

## Variables y secretos

| Variable | Valor por defecto | Efecto |
| --- | --- | --- |
| `VIMEUS_VIEW_KEY` | — | Clave para el embed de Vimeus. **Obligatoria. Configúrala como secreto; no la guardes en Git ni la compartas en el chat.** |
| `VIMEUS_ORIGIN` | `https://vimeus.com` | Origen de Vimeus. |
| `VIMEUS_REFERER` | `https://vimeus.com/` | Referer con el que se pide el embed de Vimeus (equivale al `referrerpolicy="origin"` del iframe). Según la documentación oficial el único dominio de embed válido es `vimeus.com`, así que el valor por defecto es el correcto; cámbialo sólo si Vimeus te autoriza otro origen. Para el HLS de terceros se usa automáticamente el origen del host donde apareció. |
| `VIMEUS_API_KEY` | — | API Key de la API de listado (`X-API-Key`). Opcional: habilita los catálogos. Configúrala como secreto; es de uso exclusivo en servidor. |
| `VIMEUS_MOVIE_PATH` | `/e/movie` | Ruta de película en Vimeus. |
| `VIMEUS_SERIES_PATHS` | `/e/serie,/e/anime` | Rutas probadas para series/anime, en ese orden. |
| `VIEW_KEY` | — | Alias heredado de `VIMEUS_VIEW_KEY`. |
| `PROXY_HLS` | `0` | `1` → devolver HLS a través del proxy del Worker. |
| `DEEP_SCAN` | `1` | `0` → no seguir iframes/configuración. Con Vimeus debe estar activo: el HLS vive en el iframe del tercero. |
| `MAX_DEEP_SCAN` | `6` | Máximo de páginas extra que sigue el deep scan (se piden en lotes de 2). |
| `DEBUG_TOKEN` | — | Habilita `/debug/...?token=`. Configúralo como secreto y sólo mientras depuras. |
| `MAX_STREAMS` | `3` | Máximo de playlists alternativas devueltas. |
| `VERIFY_HLS` | `1` | Solicita cada candidato y exige una respuesta HLS `#EXTM3U`. Usa `0` para desactivar la verificación. |
| `NOT_WEB_READY` | `1` | En modo directo, marca el stream como no listo para navegador cuando requiere cabeceras. Se ignora con `PROXY_HLS=1`. |

## Despliegue en Cloudflare

1. Despliega el Worker con Wrangler o desde el panel de Cloudflare.
2. En producción, configura la clave **sin ponerla en `wrangler.toml`**:

   ```bash
   npx wrangler secret put VIMEUS_VIEW_KEY
   ```

3. Si la clave está restringida por dominio, configura `VIMEUS_REFERER` con el origen autorizado. El Worker no evade una lista de dominios: si Vimeus rechaza la solicitud, el addon responde sin streams y lo indica en `X-Proxy-Detail`.
4. Instala en Stremio: `https://TU-WORKER.workers.dev/manifest.json`.

El nombre del Worker en `wrangler.toml` y el `id` del manifiesto (`com.cf.unlimplay.proxy`) se conservan para que la URL `*.workers.dev` y las instalaciones existentes de Stremio sigan funcionando tras actualizar. Para un dominio propio, configura la ruta `routes` en `wrangler.toml` según Cloudflare.

## Desarrollo y pruebas locales

```bash
npm test                     # pruebas unitarias y del router, sin red

# Terminal 1: origen mock (embed Vimeus + CDN de prueba)
npm run mock                 # http://0.0.0.0:8788

# Terminal 2: Worker apuntando al mock
npm run dev:local            # http://0.0.0.0:8787
```

El mock sólo acepta la clave de desarrollo `local-test-key`; no es una clave real ni debe usarse en producción. Reproduce respuestas HLS directas, deep scan, scripts empaquetados, páginas sin stream, playlists, segmentos `Range` y solicitudes sin `Referer`.

Ejemplos con el Worker local:

```bash
curl -s localhost:8787/manifest.json | jq
curl -s localhost:8787/stream/movie/tt1234567.json | jq
curl -s localhost:8787/stream/movie/tt9999999.json | jq         # deep scan vía /api/source
curl -s localhost:8787/stream/movie/tt5555555.json | jq         # script ofuscado (p.a.c.k.e.r)
curl -s localhost:8787/stream/movie/tt0000000.json -D -         # HLS ausente → diagnóstico
curl -s localhost:8787/stream/series/tt0903747:1:2.json | jq
```

Las pruebas mockeadas cubren `view_key` ausente/incorrecta, extracción de URLs, fallos 4xx/5xx, series/anime, cabeceras de Vimeus, proxy de playlists/segmentos, CORS y saneamiento de diagnósticos. No demuestran disponibilidad real del proveedor: la reproducción real debe verificarse con una clave y contenido autorizados.

## Notas

- Timeout de 9 s por solicitud de origen; el deep scan está acotado a `MAX_DEEP_SCAN` páginas (6 por defecto, en lotes de 2).
- El Worker conserva las rutas originales de Stremio y el ID de manifiesto para no obligar a reinstalar el addon.
- `X-Proxy-Detail` se limita y sanea; las claves y tokens no se exponen en esos diagnósticos.
- Respeta los términos del proveedor y usa únicamente fuentes/contenidos para los que tengas autorización. Este addon no aloja ni distribuye archivos multimedia.

## Licencia

AGPL-3.0-or-later. Consulta [`LICENSE`](LICENSE).
