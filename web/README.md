# ZX Web — cliente de addons Stremio

Interfaz web que instala **addons de Stremio** (`manifest.json`) y reproduce sus streams con:

| Motor | Para qué |
| --- | --- |
| **MediaFlow Proxy** | HLS / DASH / HTTP con cabeceras (`Referer`, `Origin`) |
| **TorrServer** | `infoHash` / magnet → HTTP Range local |
| **Webtor API v1** | REST `https://api.webtor.io/v1` (`Authorization: Bearer`). Las URLs de stream salen ya firmadas hacia `*.api.cosmic-crab.buzz` |
| **ZX Player (Media3)** | Reproductor HTML5 inspirado en Media3 ExoPlayer + `hls.js` |

Media3 ExoPlayer es una librería de Android: en el navegador no puede ejecutarse. ZX Player replica su barra de controles, *seek*, velocidad, subtítulos y teclas (espacio, flechas, F, M, Esc) sobre MSE/`hls.js`.

## Arranque

```bash
npm run web
# http://0.0.0.0:8787
```

Cinemeta viene instalado para catálogos y fichas. En **Addons** pega cualquier `https://…/manifest.json` (Torrentio, MediaFusion, el Worker Vimeus de este repo, etc.).

## Ajustes

En **Motores** configura las URLs de tu red. TorrServer y MediaFlow se llaman **desde el navegador** (suelen vivir en tu LAN: `127.0.0.1:8090` / `:8888`). Webtor pasa por el proxy CORS del servidor.

Docker de referencia:

```bash
docker run -p 8888:8888 -e API_PASSWORD=secreto mhdzumair/mediaflow-proxy
docker run -p 8090:8090 ghcr.io/yourok/torrserver
```

## Webtor API ([docs](https://api.webtor.io/v1/docs/index.html))

Contrato que usa ZX:

1. `POST /resource` — cuerpo = magnet en crudo (`text/plain`). Devuelve el infohash. Un magnet frío puede tardar minutos (408 si no resuelve).
2. `GET /resource/{id}/list?output=list` — `id` de cada archivo es el `content_id` de export. `limit` por defecto es 10; ZX pagina.
3. `GET /resource/{id}/export/{content_id}?types=stream,download` — `exports.stream` / `html_tag.sources`. **Las URLs llevan su propia auth y caducan: no se guardan ni se reescribe el host.**
4. Opcional `POST /library` `{ "resource_id" }` para que aparezca en WebDAV/S3.
5. `GET /profile` — plan y email. Sin key o plan free → `unauthorized` / `payment_required` (402).
6. Device login: `POST /device/code` + `POST /device/token` (RFC 8628), botón «Vincular con webtor.io».

La key se emite en [webtor.io/profile](https://webtor.io/profile). El host `abra--5e4bd524.api.cosmic-crab.buzz` **no** es el REST: es un nodo de export al que apuntan esas URLs firmadas.

## Cómo se elige el motor

1. URL HTTP/HLS/DASH → directo, o MediaFlow si hay cabeceras / `notWebReady`.
2. Torrent (`infoHash` / magnet) → TorrServer, y si falla Webtor (`auto`).
3. `ytId` / `externalUrl` → se abre fuera.

El servidor (`server.mjs`) sólo sirve estáticos y un proxy a hosts **públicos** (`/api/fetch`). No reenvía a localhost (SSRF).
