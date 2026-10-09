# UnlimPlay Proxy Stream — Addon de Stremio en Cloudflare Workers

Worker (formato **ES Module**) que actúa como *addon proxy* de Stremio: resuelve el
flujo **HLS (`.m3u8`)** que sirve el reproductor embebido de UnlimPlay, haciendo el
scraping **desde el edge de Cloudflare** y devolviendo la respuesta en el formato
exacto del protocolo de addons de Stremio.

```
Stremio ──▶ /stream/movie/tt1234567.json ──▶ Worker (edge)
                                               │  fetch() con UA + Referer de navegador
                                               ▼
                                    https://unlimplay.com/f/embed/movie/tt1234567
                                               │  HTML/JS del reproductor
                                               ▼
                                    regex → https://cdn…/master.m3u8?token=…
                                               │
Stremio ◀── {"streams":[{…behaviorHints…}]} ◀──┘
```

---

## 1. Endpoints

| Método | Ruta | Descripción |
| --- | --- | --- |
| `GET` | `/manifest.json` | Manifiesto oficial del addon. |
| `GET` | `/stream/movie/{id}.json` | Extrae y devuelve el `.m3u8` del embed. |
| `GET` | `/proxy?url=<URL>` | Pasarela HLS opcional (playlist + segmentos + claves). |
| `GET` | `/` | Healthcheck JSON. Si el navegador envía `Accept: text/html`, sirve una consola de pruebas para resolver un id sin instalar Stremio. |
| `OPTIONS` | cualquier ruta | Preflight CORS (`204` + cabeceras `Access-Control-*`). |

Todas las respuestas llevan `Access-Control-Allow-Origin: *`.

### `/manifest.json`

```json
{
  "id": "com.cf.unlimplay.proxy",
  "version": "1.0.0",
  "name": "UnlimPlay Proxy Stream",
  "description": "Addon proxy que resuelve flujos HLS (.m3u8) desde el embed de UnlimPlay en el edge de Cloudflare.",
  "logo": "https://unlimplay.com/favicon.ico",
  "background": "https://unlimplay.com/assets/images/background.jpg",
  "resources": ["stream"],
  "types": ["movie"],
  "idPrefixes": ["tt", "tmdb:"],
  "behaviorHints": { "configurable": false, "configurationRequired": false }
}
```

### `/stream/movie/{id}.json`

Acepta `tt1234567`, `tt1234567.json`, `tmdb:550`, `tmdb:movie:550`, `imdb:tt550`…
El id se limpia (prefijos, `.json`, `%`-escapes, query) antes de construir
`https://unlimplay.com/f/embed/movie/{id}`.

Respuesta con stream encontrado:

```json
{
  "streams": [
    {
      "name": "UnlimPlay Proxy Stream",
      "title": "UnlimPlay 1080p [HLS Edge]",
      "type": "hls",
      "url": "https://cdn…/hls/tt1234567/master.m3u8?token=abc123",
      "behaviorHints": {
        "notSupported": false,
        "notWebReady": true,
        "requestHeaders": {
          "Referer": "https://unlimplay.com/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
        },
        "proxyHeaders": {
          "request": {
            "Referer": "https://unlimplay.com/",
            "User-Agent": "Mozilla/5.0 …",
            "Origin": "https://unlimplay.com"
          }
        },
        "bingeGroup": "unlimplay-0"
      }
    }
  ]
}
```

> **Nunca falla.** Si el id es inválido, el origen responde 4xx/5xx, la red se cae,
> se agota el timeout o no hay ningún `.m3u8` en el HTML, el Worker devuelve
> `200 {"streams": []}`. Stremio simplemente no muestra el addon en lugar de romperse.
> El motivo real viaja en las cabeceras de diagnóstico `X-Proxy-Error`
> (`bad-id` · `not-found` · `upstream`) y `X-Proxy-Detail`, visibles con
> `curl -D -` o en Workers Logs.

Campos extra respecto al mínimo del enunciado y por qué están:

| Campo | Motivo |
| --- | --- |
| `behaviorHints.proxyHeaders` | Formato moderno de Stremio (≥ 1.6) para inyectar cabeceras; `requestHeaders` se mantiene por compatibilidad. |
| `behaviorHints.notWebReady` | En modo directo el stream necesita `Referer`, que un navegador no puede enviar. Se ignora en modo `PROXY_HLS`. |
| `behaviorHints.bingeGroup` | Agrupa las variantes del mismo título en la UI de Stremio. |
| `name` | Etiqueta el origen del stream en el selector de Stremio. |

---

## 2. Cómo se extrae el `.m3u8`

El HTML/JS del embed se **normaliza** antes de aplicar las regex, porque estos
reproductores nunca entregan la URL en claro:

| Truco del embed | Normalización |
| --- | --- |
| `https:\/\/cdn…\/master.m3u8` (JSON escapado) | `\/` → `/`, `\"` → `"` |
| `\u002F`, `\x2F`, `&#47;`, `&#x2F;`, `&sol;` | → `/` |
| `&amp;` en el token | → `&` |
| `"https://cdn/x/" + "master.m3u8"` | se une en una segunda pasada *flat* |

Después se aplican **cuatro patrones ordenados por confianza**:

1. **Clave de reproductor** (peso 100) — `file|src|source|url|hlsUrl|videoUrl|playUrl|streamUrl|playlist|manifest|m3u8|link|media|path` seguido de `:` o `=` y una URL entrecomillada. Cubre JWPlayer, Plyr, Video.js, Clappr y hls.js.
2. **Literal entrecomillado** (peso 60) — cualquier `"…​.m3u8…"` suelto en el documento.
3. **URL desnuda** (peso 30) — sin comillas, con *lookahead* de delimitador para no recortar rutas mayores (`…/a.m3u8backup/file.bin` no produce un falso `…/a.m3u8`) y con *lookbehind* `(?<!:)` para no robar las barras de `ftp://` o `rtsp://`.
4. **Recombinación** (peso 45, último recurso) — si no apareció ninguna URL absoluta, se combinan los fragmentos `*.m3u8` relativos con los prefijos base `"https://…/"` del propio documento, que es justo lo que hace el JS del reproductor al concatenar variables.

Cada candidato se **absolutiza** (relativas y `//protocol-relative` contra la URL del
embed), se **valida** (`pathname` terminado en `.m3u8`, sólo `http`/`https`, host con
punto), se **deduplica** y se **puntúa**:

- `+5` si el host es un CDN distinto del host del embed,
- `+3` si la ruta contiene `master|index|playlist|chunklist|manifest`,
- `+2` si la query lleva `token|sign|signature|hash|expire|key|auth`.

El resultado se ordena de mayor a menor confianza y se devuelven los `MAX_STREAMS`
primeros: el primero con el título `UnlimPlay 1080p [HLS Edge]` y los siguientes como
`… · Alt 2`, `… · Alt 3`.

### Deep scan (fallback)

Muchos embeds **no** traen el `.m3u8` en el HTML: el reproductor lo pide por XHR a un
endpoint de configuración. Si la extracción directa no encuentra nada y `DEEP_SCAN=1`
(por defecto), el Worker busca en el HTML URLs tipo `/api/…`, `…/source…`,
`…/player…`, `*.json`, `*.php?…` (descartando estáticos `.js/.css/.png/…`), consulta
**como máximo 2** de ellas y vuelve a aplicar los cuatro patrones sobre la respuesta.

### Páginas enormes

`truncateSmart()` conserva **cabeza y cola** del documento (1,5 M de caracteres cada
una) en vez de recortar sólo por el principio: JWPlayer se configura al inicio del
HTML y hls.js al final, así que ningún corte deja fuera el `.m3u8`.

---

## 3. Variables de entorno

| Variable | Por defecto | Efecto |
| --- | --- | --- |
| `PROXY_HLS` | `"0"` | `"1"` → la URL del stream apunta a `/proxy?url=…` y el Worker inyecta él las cabeceras. Necesario para Stremio Web y para CDNs que bloquean peticiones sin `Referer`. |
| `DEEP_SCAN` | `"1"` | `"0"` desactiva las peticiones extra a endpoints de configuración. |
| `MAX_STREAMS` | `"3"` | Nº de candidatos `.m3u8` devueltos como streams. |
| `NOT_WEB_READY` | `"1"` | `"0"` muestra el stream también en Stremio Web aunque dependa de cabeceras. Se ignora con `PROXY_HLS=1`. |
| `SOURCE_ORIGIN` | `https://unlimplay.com` | Origen del embed. Estos dominios rotan: se cambia sin redesplegar código. |
| `EMBED_PATH` | `/f/embed/movie/` | Ruta del reproductor embebido. |

---

## 4. Despliegue

### Opción A — Panel de Cloudflare (copiar y pegar)

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Worker**.
2. **Edit code** → borra el contenido de `worker.js` → pega **`src/index.js`** entero.
3. **Deploy**.
4. (Opcional) **Settings → Variables and Secrets** → añade las variables de la tabla
   anterior como *Text*.
5. Instala en Stremio: **`https://TU-WORKER.workers.dev/manifest.json`**
   (o directamente la URL `stremio://` que genera la app).

El fichero es autocontenido: no importa dependencias ni usa bindings, así que funciona
tal cual en el editor del panel.

### Opción B — Wrangler (recomendado, con control de versiones)

```bash
npm install          # instala wrangler
npm run deploy       # wrangler deploy  → usa wrangler.toml
```

`wrangler.toml` ya declara `name`, `main = "src/index.js"`, `compatibility_date`,
`nodejs_compat`, observabilidad activada y las `[vars]` por defecto. Para un dominio
propio, descomenta el bloque `routes`.

---

## 5. Desarrollo y pruebas locales

```bash
npm test                     # 58 tests (node:test, sin red)

# Terminal 1: origen de vídeo de pega (embed + CDN, exige Referer)
npm run mock                 # http://0.0.0.0:8788

# Terminal 2: Worker en local apuntando al origen de pega
npm run dev:local            # http://0.0.0.0:8787
npm run tail                 # logs en producción
```

`tools/mock-origin.mjs` reproduce tres escenarios reales — JWPlayer con la URL escapada
(`\/`), deep scan contra `/api/source/{id}` y una página sin stream — y **devuelve 403
si la petición no trae `Referer`**, lo que permite comprobar de verdad que el Worker y
la pasarela HLS inyectan las cabeceras.

Verificación manual:

```bash
curl -s localhost:8787/manifest.json | jq
curl -s localhost:8787/stream/movie/tt1234567.json | jq          # JWPlayer escapado
curl -s localhost:8787/stream/movie/tt9999999.json | jq          # deep scan
curl -s localhost:8787/stream/movie/tt0000000.json               # {"streams":[]}
curl -s localhost:8787/stream/movie/tmdb:movie:550.json | jq     # limpieza de prefijos
curl -s "localhost:8787/proxy?url=$(python3 -c "import urllib.parse;print(urllib.parse.quote('http://127.0.0.1:8788/hls/tt1234567/master.m3u8',safe=''))")"
```

### Cobertura de los tests

`test/extract.test.mjs` — lógica pura: `cleanId`, `normalizeSource`, `absolutize`,
`extractM3u8Urls` (JWPlayer, Plyr, Video.js, hls.js, JSON minificado, entidades HTML,
URLs sin comillas, concatenaciones, deduplicación, orden por confianza, falsos
positivos, protocolos raros), `findConfigUrls`, `rewritePlaylist`, `truncateSmart`,
`resolveSource`, `buildManifest` y `healthHtml`.

`test/router.test.mjs` — integración con `fetch()` mockeado (sin red): preflight CORS,
cabeceras en todas las rutas, 404/405, healthcheck, contrato del manifiesto, forma
exacta del objeto `stream` y de `behaviorHints`, limpieza del id, id inválido, HTML sin
`.m3u8`, origen 500, excepción de red, deep scan activado/desactivado, varios
candidatos, `MAX_STREAMS`, `PROXY_HLS=1`, reescritura de playlists, segmentos con
`Range`/`206`, validación del parámetro `url`, bloqueo de bucles de proxy, 502 del CDN,
negociación de contenido en `/` (HTML vs JSON), `SOURCE_ORIGIN` por env y dos regresiones
(cabeceras con caracteres no Latin-1 y mayúsculas del id al enrutar).

---

## 6. Notas de implementación

- **`Request.cf` / `cf:` no se usa a propósito**: mantiene el Worker portable y
  ejecutable en tests con Node sin mocks extra.
- **Timeout de 9 s** con `AbortSignal.timeout()` en cada `fetch` de scraping: un origen
  colgado no puede agotar el tiempo de CPU del Worker ni dejar a Stremio esperando.
- **Cabeceras HTTP saneadas** (`safeHeaderValue`): los mensajes de error pueden contener
  Unicode y HTTP sólo admite *ByteString* (Latin-1). Sin este saneado, un `→` en un log
  hacía lanzar al construir la respuesta de diagnóstico.
- **`X-Proxy-Detail` se trunca a 200 caracteres** y se eliminan `\r\n` (anti
  *header injection*).
- **Anti-SSRF en `/proxy`**: sólo `http(s)` y se rechazan URLs que apunten al propio
  Worker (bucle).
- **Sin secretos**: no hay claves API ni tokens en el código, así que no se necesita
  `.dev.vars`.
- **Coste**: 1 subrequest por stream (3 como máximo con deep scan) y, en modo proxy,
  1 subrequest por playlist/segmento. Dentro del plan gratuito de Workers conviene
  vigilar el número de subrequests si el addon se comparte.

---

## 7. Estructura del proyecto

```
.
├── src/index.js            # El Worker. Autocontenido: copiar y pegar en el panel.
├── tools/mock-origin.mjs   # Origen de vídeo de pega (sólo desarrollo).
├── test/
│   ├── extract.test.mjs    # Tests de la lógica de extracción.
│   └── router.test.mjs     # Tests de integración del router (fetch mockeado).
├── wrangler.toml           # Despliegue con wrangler + variables por defecto.
├── package.json
└── LICENSE                 # AGPL-3.0
```

## 8. Licencia y aviso

AGPL-3.0-or-later (ver [`LICENSE`](LICENSE)).

Este código es material de estudio sobre el protocolo de addons de Stremio, scraping
desde el edge y manipulación de playlists HLS. El addon no aloja ni distribuye
contenido: sólo resuelve lo que un tercero ya publica. Es responsabilidad de quien lo
despliegue comprobar que el uso del servicio de origen y del contenido resultante es
lícito en su jurisdicción y respeta los términos del proveedor.
