import { describe, expect, mock, test } from "bun:test";

// Stub evlog/elysia before importing render modules
mock.module("evlog/elysia", () => ({
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
  useLogger: () => ({ set() {} }),
  evlog: () => (app: unknown) => app,
}));

mock.module("evlog", () => ({
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stubs
  log: { warn: () => {}, error: () => {}, info: () => {}, set: () => {} },
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stubs
  createLogger: () => ({ set() {}, error() {}, emit() {}, info() {}, warn() {} }),
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
  useLogger: () => ({ set() {} }),
}));

import type { Context } from "elysia";
import type { HTTPHeaders } from "elysia/types";
import { defer } from "../src/client";
import { runLoaders } from "../src/render/loaders";
import type { ResolvedRoute } from "../src/router";

function makeCtx(overrides: Partial<Context> = {}): Context {
  return {
    params: {},
    query: {},
    request: new Request("http://localhost/test"),
    headers: {},
    cookie: {},
    redirect: (url: string) => new Response(null, { status: 302, headers: { Location: url } }),
    set: { headers: {} as HTTPHeaders },
    path: "/test",
    ...overrides,
  } as Context;
}

function makeRoute(
  pageLoader: (() => unknown) | undefined,
  routeLoaders: (() => unknown)[] = []
): ResolvedRoute {
  return {
    pattern: "/test",
    path: "/test",
    mode: "ssr",
    routeChain: routeLoaders.map((loader) => ({
      __type: "FURIN_ROUTE" as const,
      loader: loader as (ctx: Record<string, unknown>) => Promise<Record<string, unknown>>,
    })),
    page: pageLoader
      ? {
          __type: "FURIN_PAGE" as const,
          _route: { __type: "FURIN_ROUTE" as const },
          component: () => null,
          loader: pageLoader as (ctx: Record<string, unknown>) => Promise<Record<string, unknown>>,
        }
      : {
          __type: "FURIN_PAGE" as const,
          _route: { __type: "FURIN_ROUTE" as const },
          component: () => null,
        },
    segmentBoundaries: [],
  } as unknown as ResolvedRoute;
}

describe("runLoaders — DeferredData", () => {
  test("loader normal (sans defer) → syncData contient tout, deferredPromises absent", async () => {
    const route = makeRoute(() => ({ title: "hello", count: 42 }));
    const result = await runLoaders(route, makeCtx(), { __type: "FURIN_ROUTE" });

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }

    expect(result.syncData).toEqual({ title: "hello", count: 42 });
    expect(result.deferredPromises).toBeUndefined();
  });

  test("loader avec defer() → syncData contient les scalaires, deferredPromises les Promises", async () => {
    const statsPromise = Promise.resolve(99);
    const route = makeRoute(() => defer({ title: "hello", stats: statsPromise }));
    const result = await runLoaders(route, makeCtx(), { __type: "FURIN_ROUTE" });

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }

    expect(result.syncData).toEqual({ title: "hello" });
    expect(result.deferredPromises).toBeDefined();
    expect(result.deferredPromises?.stats).toBeInstanceOf(Promise);
    expect(await result.deferredPromises?.stats).toBe(99);
  });

  test("les Promises dans defer() ne sont PAS awaited dans syncData", async () => {
    let resolved = false;
    const slowPromise = new Promise<number>((r) =>
      setTimeout(() => {
        resolved = true;
        r(1);
      }, 50)
    );
    const route = makeRoute(() => defer({ x: slowPromise }));

    const result = await runLoaders(route, makeCtx(), { __type: "FURIN_ROUTE" });

    expect(result.type).toBe("data");
    // runLoaders should return immediately without waiting for the slow Promise
    expect(resolved).toBe(false);
    if (result.type !== "data") {
      return;
    }
    expect(result.deferredPromises?.x).toBeInstanceOf(Promise);
  });

  test("plusieurs Promises déférées sont toutes dans deferredPromises", async () => {
    const route = makeRoute(() =>
      defer({
        title: "board",
        stats: Promise.resolve(1),
        users: Promise.resolve([]),
      })
    );
    const result = await runLoaders(route, makeCtx(), { __type: "FURIN_ROUTE" });

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }

    expect(result.syncData).toEqual({ title: "board" });
    expect(result.deferredPromises).toHaveProperty("stats");
    expect(result.deferredPromises).toHaveProperty("users");
  });

  test("loader dans la routeChain (non-page) → données normales, pas de split deferred", async () => {
    const route = makeRoute(() => ({ pageTitle: "page" }), [() => ({ routeData: "from-route" })]);
    const result = await runLoaders(route, makeCtx(), { __type: "FURIN_ROUTE" });

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }
    expect(result.syncData).toMatchObject({ routeData: "from-route", pageTitle: "page" });
    expect(result.deferredPromises).toBeUndefined();
  });
});
