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
  test("normal loader (without defer) → syncData contains everything, deferredPromises absent", async () => {
    const route = makeRoute(() => ({ title: "hello", count: 42 }));
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }

    expect(result.syncData).toMatchObject({ title: "hello", count: 42 });
    expect(result.deferredPromises).toBeUndefined();
  });

  test("loader with defer() → syncData contains scalars, deferredPromises the Promises", async () => {
    const statsPromise = Promise.resolve(99);
    const route = makeRoute(() => defer({ title: "hello", stats: statsPromise }));
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }

    expect(result.syncData).toMatchObject({ title: "hello" });
    expect(result.deferredPromises).toBeDefined();
    expect(result.deferredPromises?.stats).toBeInstanceOf(Promise);
    expect(await result.deferredPromises?.stats).toBe(99);
  });

  test("Promises in defer() are NOT awaited in syncData", async () => {
    let resolved = false;
    const slowPromise = new Promise<number>((r) =>
      setTimeout(() => {
        resolved = true;
        r(1);
      }, 50)
    );
    const route = makeRoute(() => defer({ x: slowPromise }));

    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    // runLoaders should return immediately without waiting for the slow Promise
    expect(resolved).toBe(false);
    if (result.type !== "data") {
      return;
    }
    expect(result.deferredPromises?.x).toBeInstanceOf(Promise);
  });

  test("multiple deferred Promises are all in deferredPromises", async () => {
    const route = makeRoute(() =>
      defer({
        title: "board",
        stats: Promise.resolve(1),
        users: Promise.resolve([]),
      })
    );
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }

    expect(result.syncData).toMatchObject({ title: "board" });
    expect(result.deferredPromises).toHaveProperty("stats");
    expect(result.deferredPromises).toHaveProperty("users");
  });

  test("thenables in defer() are treated as deferred Promises", async () => {
    const thenable = {
      // biome-ignore lint/suspicious/noThenProperty: intentional thenable — testing that defer() treats objects with a then method as deferred Promises
      then(resolve: (value: number) => void) {
        resolve(7);
      },
    };
    const route = makeRoute(() => defer({ title: "hello", stats: thenable }));

    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }
    expect(result.syncData).toMatchObject({ title: "hello" });
    expect(result.syncData).not.toHaveProperty("stats");
    expect(result.deferredPromises?.stats).toBeInstanceOf(Promise);
    expect(await result.deferredPromises?.stats).toBe(7);
  });

  test("loader in routeChain (non-page) → normal data, no deferred split", async () => {
    const route = makeRoute(() => ({ pageTitle: "page" }), [() => ({ routeData: "from-route" })]);
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }
    expect(result.syncData).toMatchObject({ routeData: "from-route", pageTitle: "page" });
    expect(result.deferredPromises).toBeUndefined();
  });

  test("route loader returning defer() → deferred fields stream alongside page data", async () => {
    const route = makeRoute(
      () => ({ pageTitle: "page" }),
      [() => defer({ shared: Promise.resolve("layout-async") })]
    );
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }
    expect(result.syncData).toMatchObject({ pageTitle: "page" });
    expect(result.deferredPromises?.shared).toBeInstanceOf(Promise);
    expect(await result.deferredPromises?.shared).toBe("layout-async");
  });

  test("layout deferred + page sync → layout Promises split, layout scalars merged into syncData", async () => {
    const route = makeRoute(
      () => ({ pageTitle: "page", count: 3 }),
      [() => defer({ user: "alice", widgets: Promise.resolve(["w1", "w2"]) })]
    );
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }
    expect(result.syncData).toMatchObject({ user: "alice", pageTitle: "page", count: 3 });
    expect(result.syncData).not.toHaveProperty("widgets");
    expect(result.deferredPromises?.widgets).toBeInstanceOf(Promise);
    expect(await result.deferredPromises?.widgets).toEqual(["w1", "w2"]);
  });

  test("layout deferred + page deferred → all Promises merged into a single deferredPromises", async () => {
    const route = makeRoute(
      () => defer({ pageTitle: "page", stats: Promise.resolve(42) }),
      [() => defer({ user: "alice", widgets: Promise.resolve(["w1"]) })]
    );
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }
    expect(result.syncData).toMatchObject({ user: "alice", pageTitle: "page" });
    expect(result.deferredPromises).toHaveProperty("widgets");
    expect(result.deferredPromises).toHaveProperty("stats");
    expect(await result.deferredPromises?.stats).toBe(42);
    expect(await result.deferredPromises?.widgets).toEqual(["w1"]);
  });

  test("two layouts in chain, only one deferred → only its Promises are split out", async () => {
    const route = makeRoute(
      () => ({ pageTitle: "page" }),
      [() => ({ org: "acme" }), () => defer({ user: "alice", widgets: Promise.resolve(["w1"]) })]
    );
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }
    expect(result.syncData).toMatchObject({ org: "acme", user: "alice", pageTitle: "page" });
    expect(result.deferredPromises).toBeDefined();
    expect(result.deferredPromises).toHaveProperty("widgets");
    expect(Object.keys(result.deferredPromises ?? {})).toEqual(["widgets"]);
  });

  test("key collision between layout and page defer → page wins (last-spread semantics)", async () => {
    const layoutPromise = Promise.resolve("from-layout");
    const pagePromise = Promise.resolve("from-page");
    const route = makeRoute(
      () => defer({ stats: pagePromise }),
      [() => defer({ stats: layoutPromise })]
    );
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }
    expect(result.deferredPromises?.stats).toBe(pagePromise);
    expect(await result.deferredPromises?.stats).toBe("from-page");
  });

  test("layout deferred Promise that rejects → exposed as a rejected Promise in deferredPromises", async () => {
    const failure = new Error("boom");
    const rejected = Promise.reject(failure);
    // Avoid unhandled-rejection noise; the consumer (streaming layer) will catch.
    rejected.catch(() => {
      /* intentional */
    });
    const route = makeRoute(() => ({ pageTitle: "page" }), [() => defer({ broken: rejected })]);
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }
    expect(result.deferredPromises?.broken).toBeInstanceOf(Promise);
    await expect(result.deferredPromises?.broken).rejects.toThrow("boom");
  });
});
