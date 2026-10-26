import test from "node:test";
import assert from "node:assert/strict";
import { mountDom, tick, APP_URL } from "./helpers/dom.mjs";

const MANIFEST = {
  id: "com.linvo.cinemeta",
  name: "Cinemeta",
  version: "3.0.14",
  resources: ["catalog", "meta"],
  types: ["movie", "series"],
  catalogs: [{ type: "movie", id: "top", name: "Populares", extra: [{ name: "search" }, { name: "skip" }] }],
};

const META = {
  id: "tt0111161",
  type: "movie",
  name: "Cadena perpetua",
  year: 1994,
  description: "Dos presos se hacen amigos en Shawshank.",
  poster: "https://image.example/poster.jpg",
  background: "https://image.example/back.jpg",
};

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("cuando un addon responde, sus catálogos sustituyen la muestra local", async () => {
  const dom = mountDom({
    fetchImpl: async (raw) => {
      const u = new URL(raw, "http://localhost:8787");
      if (u.pathname.endsWith("/manifest.json")) return jsonResponse(MANIFEST);
      if (u.pathname.includes("/catalog/")) return jsonResponse({ metas: [META] });
      if (u.pathname.includes("/meta/")) return jsonResponse({ meta: META });
      if (u.pathname.includes("/stream/")) return jsonResponse({ streams: [] });
      return jsonResponse({});
    },
  });
  const { document } = dom.window;

  await import(APP_URL);
  await tick(150);

  const strip = document.querySelector("#status-strip");
  assert.ok(strip, "debe existir la tira de estado");
  assert.ok(strip.classList.contains("online"), strip.textContent);
  assert.match(strip.textContent, /Catálogos cargados/);
  assert.equal(document.querySelector("#hero h1").textContent, "Cadena perpetua");
  assert.ok(document.querySelector('#rows .card[data-open="movie:tt0111161"]'));
  assert.equal(document.querySelectorAll(".demo-tag").length, 0, "la muestra desaparece");
  dom.window.close();
});
