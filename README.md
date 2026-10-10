# Vimeus + UnlimPlay HLS — Addon de Stremio en Cloudflare Workers

Worker ES Module que resuelve una URL HLS (`.m3u8`) para Stremio. **Vimeus es el proveedor principal; UnlimPlay se consulta únicamente si Vimeus no está configurado, falla o no devuelve un HLS.** El Worker entrega a Stremio el enlace HLS encontrado, con las cabeceras necesarias; opcionalmente puede retransmitir la playlist y sus segmentos mediante `/proxy`.

```text
Stremio ──▶ /stream/movie/tt1234567.json ──▶ Worker
                                                   │  1. Vimeus /e/movie?...&view_key=...
                                                   │     extrae HLS si está disponible
                                                   │  2. si no hay HLS → UnlimPlay /f/embed/movie/tt1234567
                                                   ▼
                                           { streams: [{ type: "hls", url: "…m3u8" }] }
```

> Configura una `VIMEUS_VIEW_KEY` autorizada como secreto del Worker. Si falta, Vimeus se omite y se intenta UnlimPlay. El resolver sólo analiza respuestas HTTP normales: no ejecuta JavaScript, no crea cookies y no inventa ni renueva tokens.

## Endpoints

| Método | Ruta | Descripción |
| --- | --- | --- |
| `GET` | `/manifest.json` | Manifiesto de Stremio. |
| `GET` | `/stream/movie/{id}.json` | Resuelve una película y devuelve el HLS. |
| `GET` | `/stream/series/{id}:{season}:{episode}.json` | Resuelve un episodio. |
| `GET` | `/proxy?url=<URL>&provider=<vimeus\|unlimplay>` | Pasarela HLS opcional para playlists, variantes y segmentos. |
| `GET` | `/` | Healthcheck JSON; con `Accept: text/html`, consola de prueba. |
| `OPTIONS` | cualquier ruta | Preflight CORS. |

Las respuestas del addon incluyen CORS. Cuando hay un stream, `X-Stream-Provider` dice qué proveedor lo entregó y `X-Provider-Attempts` resume la cascada sin revelar la clave.

## Orden y formato de los proveedores

El orden predeterminado es `vimeus,unlimplay` y se puede cambiar con `PROVIDER_ORDER`.

1. **Vimeus**: películas en `/e/movie`; series primero en `/e/serie` y, si no se encuentra HLS, se prueba `/e/anime`. El ID `tt…` se envía como `imdb`; un ID numérico, como `tmdb`. En todos los casos se añade `view_key`; para series también `se` y `ep`.
2. **UnlimPlay (respaldo)**: películas en `/f/embed/movie/{id}` y episodios en `/f/embed/tv/{id}/{season}/{episode}`.

Se pasa al proveedor siguiente cuando el anterior responde con error, no publica un `.m3u8` que el extractor reconozca, la clave no está configurada o la playlist no valida (`HTTP` no exitoso o cuerpo sin `#EXTM3U`, con `VERIFY_HLS=1`). Si Vimeus encuentra y valida HLS, UnlimPlay no se consulta.

El ID de Stremio puede ser `tt1234567`, `tmdb:550`, `tmdb:movie:550` o, para una serie, `tt0903747:1:2`. El Worker limpia prefijos/escapes y valida temporada y episodio antes de construir las URLs.

Ejemplo de respuesta:

```json
{
  "streams": [
    {
      "name": "Vimeus + UnlimPlay HLS",
      "title": "Vimeus [HLS]",
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

En modo proxy, el enlace que se entrega a Stremio lleva el proveedor en el parámetro `provider`; el Worker lo conserva al reescribir las playlists para aplicar el `Referer` correcto a variantes y segmentos. `PROXY_HLS=1` es útil para clientes que no pueden inyectar cabeceras, incluido Stremio Web.

Si todos los intentos fallan, se devuelve `200 {"streams": []}` para no romper Stremio. Los detalles van en `X-Proxy-Error`, `X-Proxy-Detail` y `X-Provider-Attempts`. Las claves `view_key` y los tokens se eliminan de los diagnósticos.

## Extracción HLS

El extractor normaliza el HTML/JS estático antes de aplicar patrones. Reconoce, entre otros casos:

- URLs JSON escapadas (`https:\/\/…`), escapes Unicode/hex y entidades HTML.
- URLs codificadas en porcentaje, incluso con doble codificación, y payloads Base64 comunes.
- Configuraciones de reproductores (`file`, `src`, `source`, `hlsUrl`, `playlist`, etc.), rutas relativas, URLs entrecomilladas y URLs construidas por concatenación.
- Redirecciones, playlists directas y referencias a iframes/configuración mediante un deep scan limitado.

Los candidatos se absolutizan, validan como URLs HTTP(S) con ruta `.m3u8`, deduplican y ordenan. El análisis es estático: **no se ejecuta el player ni se eluden controles de acceso**. Un HLS que requiere sesión, DRM o tokens no expuestos no se puede resolver con este mecanismo.

`PROXY_HLS=1` hace que `/proxy` retransmita el manifiesto y los segmentos con `Range`, CORS y cabeceras del proveedor. La URL de destino debe ser HTTP(S) y no puede apuntar al propio Worker.

## Variables y secretos

| Variable | Valor por defecto | Efecto |
| --- | --- | --- |
| `PROVIDER_ORDER` | `vimeus,unlimplay` | Orden de intento. Ej.: `unlimplay,vimeus`. |
| `VIMEUS_ORIGIN` | `https://vimeus.com` | Origen de Vimeus. |
| `VIMEUS_VIEW_KEY` | — | Clave para el embed de Vimeus. **Configúrala como secreto; no la guardes en Git ni la compartas en el chat.** |
| `VIMEUS_REFERER` | `https://vimeus.com/` | Referer enviado al pedir/reproducir el HLS. Si tu `view_key` tiene una lista de dominios permitidos, configúralo con el origen autorizado por Vimeus. |
| `VIMEUS_MOVIE_PATH` | `/e/movie` | Ruta de película en Vimeus. |
| `VIMEUS_SERIES_PATHS` | `/e/serie,/e/anime` | Rutas probadas para series/anime, en ese orden. |
| `VIEW_KEY` | — | Alias heredado de `VIMEUS_VIEW_KEY`. |
| `UNLIMPLAY_ORIGIN` | `https://unlimplay.com` | Origen de respaldo UnlimPlay. |
| `SOURCE_ORIGIN` | — | Alias heredado de `UNLIMPLAY_ORIGIN`; útil en el mock local. |
| `EMBED_PATH` | `/f/embed/movie/` | Ruta de películas UnlimPlay. |
| `TV_EMBED_PATH` | `/f/embed/tv/` | Ruta de episodios UnlimPlay. |
| `PROXY_HLS` | `0` | `1` → devolver HLS a través del proxy del Worker. |
| `DEEP_SCAN` | `1` | `0` → no seguir referencias estáticas a iframes/configuración. |
| `MAX_STREAMS` | `3` | Máximo de playlists alternativas del proveedor que tuvo éxito. |
| `VERIFY_HLS` | `1` | Solicita cada candidato y exige una respuesta HLS `#EXTM3U`; si no valida, prueba el proveedor de respaldo. Usa `0` para desactivar la verificación. |
| `NOT_WEB_READY` | `1` | En modo directo, marca el stream como no listo para navegador cuando requiere cabeceras. Se ignora con `PROXY_HLS=1`. |

## Despliegue en Cloudflare

1. Despliega el Worker con Wrangler o desde el panel de Cloudflare.
2. En producción, configura la clave **sin ponerla en `wrangler.toml`**:

   ```bash
   npx wrangler secret put VIMEUS_VIEW_KEY
   ```

3. Si la clave está restringida por dominio, configura `VIMEUS_REFERER` con el origen autorizado. El Worker no evade una lista de dominios: si Vimeus rechaza la solicitud, el intento continúa con UnlimPlay.
4. Instala en Stremio: `https://TU-WORKER.workers.dev/manifest.json`.

`wrangler.toml` deja el orden en `vimeus,unlimplay`. Para un dominio propio, configura la ruta `routes` ahí según Cloudflare.

## Desarrollo y pruebas locales

```bash
npm test                     # pruebas unitarias y del router, sin red

# Terminal 1: origen mock (Vimeus + UnlimPlay + CDN de prueba)
npm run mock                 # http://0.0.0.0:8788

# Terminal 2: prueba Vimeus principal y fallback local
npm run dev:vimeus:local     # http://0.0.0.0:8787

# Alternativa: probar sólo el fallback UnlimPlay
npm run dev:local
```

El mock sólo acepta la clave de desarrollo `local-test-key`; no es una clave real ni debe usarse en producción. Reproduce respuestas HLS directas, deep scan, páginas sin stream, playlists, segmentos `Range` y solicitudes sin `Referer`.

Ejemplos con el Worker local:

```bash
curl -s localhost:8787/manifest.json | jq
curl -s localhost:8787/stream/movie/tt1234567.json | jq
curl -s localhost:8787/stream/movie/tt0000000.json -D -  # HLS ausente → respaldo/diagnóstico
curl -s localhost:8787/stream/series/tt0903747:1:2.json | jq
```

Las pruebas mockeadas cubren orden Vimeus→UnlimPlay, `view_key` ausente/incorrecta, extracción de URLs, fallos 4xx/5xx, series/anime, cabeceras por proveedor, proxy de playlists/segmentos, CORS y saneamiento de diagnósticos. No demuestran disponibilidad real de los proveedores: la reproducción real debe verificarse con una clave y contenido autorizados.

## Notas

- Timeout de 9 s por solicitud de origen; el deep scan está acotado a cuatro referencias por proveedor.
- El Worker conserva las rutas originales de Stremio y el ID de manifiesto para no obligar a reinstalar el addon.
- `X-Proxy-Detail` se limita y sanea; las claves y tokens no se exponen en esos diagnósticos.
- Respeta los términos de cada proveedor y usa únicamente fuentes/contenidos para los que tengas autorización. Este addon no aloja ni distribuye archivos multimedia.

## Licencia

AGPL-3.0-or-later. Consulta [`LICENSE`](LICENSE).
