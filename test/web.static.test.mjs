import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../web/server.mjs";

test("el servidor sirve la web completa sin depender de hosts externos", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const cases = [
    ["/", "text/html"],
    ["/css/app.css", "text/css"],
    ["/js/app.js", "text/javascript"],
    ["/js/demo.js", "text/javascript"],
    ["/vendor/hls.min.js", "text/javascript"],
    ["/fonts/inter-latin-400-normal.woff2", "font/woff2"],
    ["/img/icon-192.png", "image/png"],
    ["/manifest.webmanifest", "application/manifest+json"],
    ["/api/health", "application/json"],
  ];
  for (const [route, type] of cases) {
    const res = await fetch(base + route);
    assert.equal(res.status, 200, `${route} → ${res.status}`);
    assert.ok((res.headers.get("content-type") || "").includes(type), `${route} content-type`);
    assert.ok((await res.arrayBuffer()).byteLength > 40, `${route} vacío`);
  }

  const index = await (await fetch(base + "/")).text();
  assert.doesNotMatch(index, /https:\/\/cdn\.|https:\/\/fonts\./);

  // Las rutas de la SPA caen en index.html para que el hash funcione al recargar.
  const deep = await fetch(base + "/detail/movie/tt0111161");
  assert.equal(deep.status, 200);
  assert.match(deep.headers.get("content-type"), /text\/html/);
  assert.match(await deep.text(), /id="view"/);

  // Un asset inexistente no se disfraza de index.html.
  const missing = await fetch(base + "/js/no-existe.js");
  assert.equal(missing.status, 404);
  assert.doesNotMatch(await missing.text(), /id="view"/);
});
