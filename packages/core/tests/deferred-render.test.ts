import { describe, expect, test } from "bun:test";
import { fromCrossJSON, toCrossJSON } from "seroval";

const SCRIPT_TAG_RE = /^<script/;

import { buildDeferredResolution, buildDeferredScript } from "../src/render/assemble";

describe("buildDeferredScript()", () => {
  test("contient l'affectation window.__FURIN_DEFERRED__", () => {
    const script = buildDeferredScript({ title: "hello" });
    expect(script).toContain("window.__FURIN_DEFERRED__");
  });

  test("sérialise _data avec les données sync", () => {
    const script = buildDeferredScript({ title: "hello", count: 42 });
    expect(script).toContain('"title"');
    expect(script).toContain('"hello"');
    expect(script).toContain('"count"');
    expect(script).toContain("42");
  });

  test("contient les méthodes resolve, reject, getPromise", () => {
    const script = buildDeferredScript({});
    expect(script).toContain("resolve(");
    expect(script).toContain("reject(");
    expect(script).toContain("getPromise(");
  });

  test("contient _resolvers: {}", () => {
    const script = buildDeferredScript({});
    expect(script).toContain("_resolvers");
  });

  test("est enveloppé dans une balise <script>", () => {
    const script = buildDeferredScript({});
    expect(script.trim()).toMatch(SCRIPT_TAG_RE);
    expect(script).toContain("</script>");
  });

  test("données vides produisent un script valide", () => {
    const script = buildDeferredScript({});
    expect(script).toContain("window.__FURIN_DEFERRED__");
  });
});

describe("buildDeferredResolution()", () => {
  test("génère un script qui appelle window.__FURIN_DEFERRED__.resolve", () => {
    const chunk = toCrossJSON("test_value");
    const script = buildDeferredResolution("stats", chunk, "resolve");
    expect(script).toContain("window.__FURIN_DEFERRED__.resolve");
    expect(script).toContain('"stats"');
  });

  test("pour une rejection, appelle window.__FURIN_DEFERRED__.reject", () => {
    const chunk = toCrossJSON(new Error("oops"));
    const script = buildDeferredResolution("stats", chunk, "reject");
    expect(script).toContain("window.__FURIN_DEFERRED__.reject");
    expect(script).toContain('"stats"');
  });

  test("est enveloppé dans une balise <script>", () => {
    const chunk = toCrossJSON(42);
    const script = buildDeferredResolution("x", chunk, "resolve");
    expect(script.trim()).toMatch(SCRIPT_TAG_RE);
    expect(script).toContain("</script>");
  });

  test("le chunk seroval peut être désérialisé par fromCrossJSON côté client (avec options vides)", () => {
    const value = { nested: { n: 1 }, arr: [1, 2, 3] };
    const chunk = toCrossJSON(value);
    const script = buildDeferredResolution("data", chunk, "resolve");
    // Simule ce que le code d'hydratation fait : JSON.parse puis fromCrossJSON
    // Format: <script>window.__FURIN_DEFERRED__.resolve("data",CHUNK)</script>
    const marker = 'resolve("data",';
    const startIdx = script.indexOf(marker) + marker.length;
    const endIdx = script.lastIndexOf(")</script>");
    const chunkStr = script.slice(startIdx, endIdx);
    const deserialized = fromCrossJSON(JSON.parse(chunkStr), {});
    expect(deserialized).toEqual(value);
  });
});
