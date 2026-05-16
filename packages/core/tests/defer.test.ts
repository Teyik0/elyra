import { describe, expect, test } from "bun:test";
import { defer, isDeferred } from "../src/client";

describe("defer()", () => {
  test("retourne un objet marqué __isDeferred = true", () => {
    const result = defer({ board: "x", stats: Promise.resolve(1) });
    expect(result.__isDeferred).toBe(true);
  });

  test("préserve les valeurs synchrones", () => {
    const result = defer({ title: "hello", count: 42 });
    expect(result.title).toBe("hello");
    expect(result.count).toBe(42);
  });

  test("préserve les Promises", async () => {
    const result = defer({ board: "x", stats: Promise.resolve(99) });
    expect(await result.stats).toBe(99);
  });

  test("les champs scalaires ne sont pas des Promises", () => {
    const result = defer({ board: "x", stats: Promise.resolve(1) });
    expect((result.board as unknown) instanceof Promise).toBe(false);
    expect((result.stats as unknown) instanceof Promise).toBe(true);
  });
});

describe("defer() — nested objects (documented limitation)", () => {
  // v1 design: defer() only splits at the TOP level. Promises buried inside
  // nested objects are passed through to syncData as-is, NOT split into
  // deferredPromises. This is intentional — less magic, more predictable —
  // and documented here as a regression filet.
  test("Promise imbriquée dans un objet : reste dans syncData, n'est pas extraite", () => {
    const innerPromise = Promise.resolve(123);
    const result = defer({
      outer: { inner: innerPromise, plain: "ok" },
      topLevel: Promise.resolve("top"),
    });

    // The top-level Promise IS recognised as deferred (it's a direct field).
    expect((result.topLevel as unknown) instanceof Promise).toBe(true);
    // The nested Promise is preserved as a Promise but lives inside a sync
    // structure — it will land in syncData, not deferredPromises.
    expect(result.outer).toEqual({ inner: innerPromise, plain: "ok" });
  });
});

describe("isDeferred()", () => {
  test("retourne true pour un objet créé par defer()", () => {
    const result = defer({ x: 1 });
    expect(isDeferred(result)).toBe(true);
  });

  test("retourne false pour un objet ordinaire", () => {
    expect(isDeferred({ x: 1 })).toBe(false);
  });

  test("retourne false si la marque est absente, héritée ou falsy", () => {
    expect(isDeferred({ __isDeferred: false })).toBe(false);
    expect(isDeferred(Object.create({ __isDeferred: true }))).toBe(false);
  });

  test("retourne false pour null/undefined/primitives", () => {
    expect(isDeferred(null)).toBe(false);
    expect(isDeferred(undefined)).toBe(false);
    expect(isDeferred(42)).toBe(false);
    expect(isDeferred("string")).toBe(false);
  });
});
