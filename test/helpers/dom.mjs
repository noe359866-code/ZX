import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

export const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "public");
export const APP_URL = pathToFileURL(path.join(PUBLIC_DIR, "js", "app.js")).href;

/**
 * Monta index.html en jsdom y expone los globals del navegador a los módulos
 * de la web, que se importan con ESM real (no se evalúan como scripts).
 */
export function mountDom({ fetchImpl } = {}) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const dom = new JSDOM(html, {
    url: "http://localhost:8787/",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const { window } = dom;
  const values = {
    window,
    document: window.document,
    location: window.location,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    FormData: window.FormData,
    AbortController: window.AbortController,
    URLSearchParams: window.URLSearchParams,
    getComputedStyle: window.getComputedStyle.bind(window),
  };
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const impl = fetchImpl || (async () => { throw new Error("sin red en el sandbox"); });
  globalThis.fetch = impl;
  window.fetch = impl;
  window.structuredClone = structuredClone;
  return dom;
}

export function tick(ms = 60) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function click(el, window) {
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
}
