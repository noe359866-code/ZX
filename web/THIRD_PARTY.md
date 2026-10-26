# Assets vendorizados (para que la web renderice sin red externa)

La interfaz no carga nada de terceros en tiempo de ejecución. Estos archivos se
copiaron desde paquetes publicados en npm y se sirven desde `web/public/`.

| Asset | Versión | Origen | Licencia |
| --- | --- | --- | --- |
| `public/vendor/hls.min.js` | hls.js 1.5.17 | `npm pack hls.js@1.5.17` → `dist/hls.min.js` | Apache-2.0 · [`public/vendor/LICENSE.hls.js`](public/vendor/LICENSE.hls.js) |
| `public/fonts/inter-latin-{400,500,600,700}-normal.woff2` | @fontsource/inter 5.3.0 | `files/*latin*` | SIL OFL 1.1 · [`public/fonts/LICENSE.inter`](public/fonts/LICENSE.inter) |
| `public/fonts/bebas-neue-latin-400-normal.woff2` | @fontsource/bebas-neue 5.3.0 | `files/*latin*` | SIL OFL 1.1 · [`public/fonts/LICENSE.bebas-neue`](public/fonts/LICENSE.bebas-neue) |
| `public/fonts/ibm-plex-mono-latin-{400,600}-normal.woff2` | @fontsource/ibm-plex-mono 5.3.0 | `files/*latin*` | SIL OFL 1.1 · [`public/fonts/LICENSE.ibm-plex-mono`](public/fonts/LICENSE.ibm-plex-mono) |

Para actualizar: `npm pack <paquete>@<versión>`, extraer el archivo indicado y
sustituirlo junto con su LICENSE. No hace falta añadir dependencias de runtime:
el servidor sólo usa módulos de Node.

`public/js/demo.js` genera sus pósters como SVG en data URI; no incluye imágenes
de terceros.
