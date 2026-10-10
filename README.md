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
| `GET` | `/proxy?url=<URL>` | Pasarela HLS opcional para playlists, variantes y segmentos. |
| `GET` | `/` | Healthcheck JSON; con `Accept: text/html`, consola de prueba. |
| `OPTIONS` | cualquier ruta | Preflight CORS. |

Las respuestas del addon incluyen CORS. Cuando hay un stream, `X-Stream-Provider: vimeus` y `X-Candidates-Found` resumen el resultado.

## Cómo se resuelve un stream

1. **Películas** → `/e/movie`.
2. **Series/anime** → primero `/e/serie`; si no se encuentra (o no valida) un HLS, se prueba `/e/anime`.

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

Si no se encuentra HLS, se devuelve `200 {"streams": []}` para no romper Stremio. Los detalles van en `X-Proxy-Error` (`missing-view-key`, `not-found`, `upstream`, `bad-id`) y `X-Proxy-Detail`. Las claves `view_key` y los tokens se eliminan de los diagnósticos.

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

## Variables y secretos

| Variable | Valor por defecto | Efecto |
| --- | --- | --- |
| `VIMEUS_VIEW_KEY` | — | Clave para el embed de Vimeus. **Obligatoria. Configúrala como secreto; no la guardes en Git ni la compartas en el chat.** |
| `VIMEUS_ORIGIN` | `https://vimeus.com` | Origen de Vimeus. |
| `VIMEUS_REFERER` | `https://vimeus.com/` | Referer enviado al pedir/reproducir el HLS. Si tu `view_key` tiene una lista de dominios permitidos, configúralo con el origen autorizado por Vimeus. |
| `VIMEUS_MOVIE_PATH` | `/e/movie` | Ruta de película en Vimeus. |
| `VIMEUS_SERIES_PATHS` | `/e/serie,/e/anime` | Rutas probadas para series/anime, en ese orden. |
| `VIEW_KEY` | — | Alias heredado de `VIMEUS_VIEW_KEY`. |
| `PROXY_HLS` | `0` | `1` → devolver HLS a través del proxy del Worker. |
| `DEEP_SCAN` | `1` | `0` → no seguir referencias estáticas a iframes/configuración. |
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

- Timeout de 9 s por solicitud de origen; el deep scan está acotado a cuatro referencias.
- El Worker conserva las rutas originales de Stremio y el ID de manifiesto para no obligar a reinstalar el addon.
- `X-Proxy-Detail` se limita y sanea; las claves y tokens no se exponen en esos diagnósticos.
- Respeta los términos del proveedor y usa únicamente fuentes/contenidos para los que tengas autorización. Este addon no aloja ni distribuye archivos multimedia.

## Licencia

AGPL-3.0-or-later. Consulta [`LICENSE`](LICENSE).
