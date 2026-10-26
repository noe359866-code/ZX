import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mountDom, tick, click, PUBLIC_DIR, APP_URL } from "./helpers/dom.mjs";

const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");

test("primer pintado sin red: HTML autocontenido, catálogo local y navegación", async () => {
  // Sin CDN: si un host externo desaparece, la web sigue viéndose completa.
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.match(html, /src="\/vendor\/hls\.min\.js"/);
  assert.match(html, /id="boot"/);
  for (const file of [
    "vendor/hls.min.js",
    "fonts/inter-latin-400-normal.woff2",
    "fonts/bebas-neue-latin-400-normal.woff2",
    "fonts/ibm-plex-mono-latin-400-normal.woff2",
    "js/demo.js",
  ]) {
    assert.ok(fs.existsSync(path.join(PUBLIC_DIR, file)), `falta el asset local ${file}`);
  }

  // fetch siempre falla: es lo que ocurre en una preview sin salida a internet.
  const dom = mountDom();
  const { window } = dom;
  const { document } = window;

  await import(APP_URL);
  await tick(150);

  const boot = document.querySelector("#boot");
  assert.ok(!boot || boot.classList.contains("off"), "la pantalla de carga se oculta");
  assert.ok(document.querySelector("#gate").classList.contains("hidden"), "con un perfil se entra directo");
  assert.match(document.querySelector("#status-strip").textContent, /Sin conexión|addons/);
  assert.equal(document.querySelector("#hero h1").textContent, "Nosferatu");
  assert.match(document.querySelector("#hero").textContent, /Muestra local/);

  const cards = document.querySelectorAll("#rows .card");
  assert.ok(cards.length >= 12, `se esperaban fichas de muestra, hay ${cards.length}`);
  assert.ok([...cards].every((c) => c.dataset.open.includes("zx-demo-")));
  assert.ok(document.querySelector(".demo-tag"), "las fichas se identifican como muestra local");
  assert.equal(document.querySelectorAll(".demo-steps .step").length, 3);

  // Navegación a la ficha, con streams locales de prueba.
  click(cards[0], window);
  await tick(100);
  assert.match(window.location.hash, /^#\/detail\/movie\/zx-demo-nosferatu/);
  assert.equal(document.querySelector(".detail h1")?.textContent, "Nosferatu");
  assert.equal(document.querySelectorAll("#streams .stream").length, 2);

  // El selector de perfiles sigue disponible y tiene una entrada directa.
  click(document.querySelector("#who"), window);
  assert.ok(!document.querySelector("#gate").classList.contains("hidden"));
  assert.ok(document.querySelector("[data-gate-start]"));

  dom.window.close();
});

test("hls.js vendorizado expone window.Hls sin descargar nada", () => {
  const dom = mountDom();
  const code = fs.readFileSync(path.join(PUBLIC_DIR, "vendor", "hls.min.js"), "utf8");
  dom.window.eval(code);
  assert.equal(typeof dom.window.Hls, "function");
  assert.equal(typeof dom.window.Hls.isSupported, "function");
  dom.window.close();
});
