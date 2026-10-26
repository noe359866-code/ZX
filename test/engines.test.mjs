import test from "node:test";
import assert from "node:assert/strict";
import { mountDom } from "./helpers/dom.mjs";

// engines.js importa store.js, que lee localStorage al cargar.
const dom = mountDom();
const { resolveStream } = await import("../web/public/js/engines.js");

test("un HLS marcado notWebReady:false se reproduce directo (sin MediaFlow)", async () => {
  const url = "https://cdn.example/master.m3u8";
  const res = await resolveStream({ url, type: "hls", behaviorHints: { notWebReady: false } });
  assert.equal(res.engine, "directo");
  assert.equal(res.playUrl, url);
  assert.equal(res.kind, "hls");
});

test("un HLS con cabeceras propias sigue pasando por MediaFlow Proxy", async () => {
  const res = await resolveStream({
    url: "https://cdn.example/master.m3u8",
    type: "hls",
    behaviorHints: { requestHeaders: { Referer: "https://vimeus.com/" } },
  });
  assert.equal(res.engine, "MediaFlow Proxy");
  assert.match(res.playUrl, /\/proxy\/hls\/manifest\.m3u8/);
  assert.match(res.playUrl, /h_Referer=/);
  dom.window.close();
});
