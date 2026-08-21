import { describe, expect, test } from "bun:test";
import { fromCrossJSON, toCrossJSON } from "seroval";
import {
  buildDeferredResolution,
  buildDeferredScript,
} from "../../../src/server/render/assemble.ts";

const SCRIPT_TAG_RE = /^<script/;
const SCRIPT_OPEN_RE = /^<script[^>]*>/;
const SCRIPT_CLOSE_RE = /<\/script>$/;

describe("buildDeferredScript()", () => {
  test("contains the window.__FURIN_DEFERRED__ assignment", () => {
    const script = buildDeferredScript([]);
    expect(script).toContain("window.__FURIN_DEFERRED__");
  });

  test("serializes deferred keys in _deferredKeys", () => {
    const script = buildDeferredScript(["stats", "comments"]);
    expect(script).toContain("_deferredKeys");
    expect(script).toContain('"stats"');
    expect(script).toContain('"comments"');
  });

  test("does NOT serialize sync data (it lives in __FURIN_DATA__)", () => {
    const script = buildDeferredScript([]);
    expect(script).not.toContain("_data");
  });

  test("contains resolve, reject, getPromise methods", () => {
    const script = buildDeferredScript([]);
    expect(script).toContain("resolve(");
    expect(script).toContain("reject(");
    expect(script).toContain("getPromise(");
  });

  test("contient _resolvers: {}", () => {
    const script = buildDeferredScript([]);
    expect(script).toContain("_resolvers");
  });

  test("is wrapped in a <script> tag", () => {
    const script = buildDeferredScript([]);
    expect(script.trim()).toMatch(SCRIPT_TAG_RE);
    expect(script).toContain("</script>");
  });

  test("empty keys produce a valid script", () => {
    const script = buildDeferredScript([]);
    expect(script).toContain("window.__FURIN_DEFERRED__");
  });
});

describe("buildDeferredResolution()", () => {
  test("generates a script that calls window.__FURIN_DEFERRED__.resolve", () => {
    const chunk = toCrossJSON("test_value");
    const script = buildDeferredResolution("stats", chunk, "resolve");
    expect(script).toContain("window.__FURIN_DEFERRED__.resolve");
    expect(script).toContain('"stats"');
  });

  test("for a rejection, calls window.__FURIN_DEFERRED__.reject", () => {
    const chunk = toCrossJSON(new Error("oops"));
    const script = buildDeferredResolution("stats", chunk, "reject");
    expect(script).toContain("window.__FURIN_DEFERRED__.reject");
    expect(script).toContain('"stats"');
  });

  test("is wrapped in a <script> tag", () => {
    const chunk = toCrossJSON(42);
    const script = buildDeferredResolution("x", chunk, "resolve");
    expect(script.trim()).toMatch(SCRIPT_TAG_RE);
    expect(script).toContain("</script>");
  });

  test("the seroval chunk can be deserialized by fromCrossJSON on the client (with empty options)", () => {
    const value = { arr: [1, 2, 3], nested: { n: 1 } };
    const chunk = toCrossJSON(value);
    const script = buildDeferredResolution("data", chunk, "resolve");
    // Simulates what the hydration code does: JSON.parse then fromCrossJSON
    // Format: <script>window.__FURIN_DEFERRED__.resolve("data",CHUNK)</script>
    const marker = 'resolve("data",';
    const startIdx = script.indexOf(marker) + marker.length;
    const endIdx = script.lastIndexOf(")</script>");
    const chunkStr = script.slice(startIdx, endIdx);
    const deserialized = fromCrossJSON(JSON.parse(chunkStr), {});
    expect(deserialized).toEqual(value);
  });

  // ── XSS hardening ─────────────────────────────────────────────────────────
  test("XSS: a value containing </script> is escaped — no tag break-out", () => {
    const evil = "</script><script>window.pwned=1</script>";
    const chunk = toCrossJSON(evil);
    const script = buildDeferredResolution("payload", chunk, "resolve");
    // The literal "</script>" sequence must NOT appear unescaped inside the
    // generated inline <script> body. safeJson() rewrites "</" to "<\\/".
    const innerBody = script.replace(SCRIPT_OPEN_RE, "").replace(SCRIPT_CLOSE_RE, "");
    expect(innerBody).not.toContain("</script>");
  });
});
