import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

mock.module("evlog/elysia", () => ({
  evlog: () => (app: unknown) => app,
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
  useLogger: () => ({ set() {} }),
}));
mock.module("evlog", () => ({
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
  initLogger: () => {},
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stubs
  log: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stubs
  useLogger: () => ({ error() {}, info() {}, set() {}, warn() {} }),
}));

import { Elysia } from "elysia";
import { defer } from "../src/client";
import { createDataEndpoint, scanPages } from "../src/server/router/index.ts";
import { __setDevMode, IS_DEV } from "../src/server/runtime-env.ts";
import { parseDeferredNdjson } from "../src/shared/deferred-ndjson.ts";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures/pages");
const DIGEST_RE = /^[0-9a-f]{10}$/;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let originalDevMode: boolean;
beforeAll(() => {
  originalDevMode = IS_DEV;
  __setDevMode(false);
});
afterAll(() => __setDevMode(originalDevMode));

describe("GET /_furin/data", () => {
  test("returns 400 if the path parameter is missing", async () => {
    const { routes } = await scanPages(FIXTURES_DIR);
    const app = new Elysia().use(createDataEndpoint(routes));

    const res = await app.handle(new Request("http://localhost/_furin/data"));

    expect(res.status).toBe(400);
  });

  test("rejects an absolute URL passed in ?path= (open-redirect prevention)", async () => {
    const { routes } = await scanPages(FIXTURES_DIR);
    const app = new Elysia().use(createDataEndpoint(routes));

    // Without the prefix/origin guard, `new URL("https://evil.com/foo", base)`
    // ignores the base and the attacker-controlled origin would propagate to
    // `syntheticRequest.url`.
    const res = await app.handle(
      new Request("http://localhost/_furin/data?path=https%3A%2F%2Fevil.com%2Ffoo")
    );

    expect(res.status).toBe(400);
  });

  test("rejects a protocol-relative path `//host/foo`", async () => {
    const { routes } = await scanPages(FIXTURES_DIR);
    const app = new Elysia().use(createDataEndpoint(routes));

    const res = await app.handle(
      new Request("http://localhost/_furin/data?path=%2F%2Fevil.com%2Ffoo")
    );

    expect(res.status).toBe(400);
  });

  test("resolves query defaults without emitting a redirect sentinel", async () => {
    const { routes } = await scanPages(FIXTURES_DIR);
    const app = new Elysia().use(createDataEndpoint(routes));

    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fquery-default"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-furin-route");

    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.__furinRedirect).toBeUndefined();
    expect(syncData.query).toEqual({ city: "Paris" });
  });

  test("passes schema-coerced query values to loaders during SPA navigation", async () => {
    const { routes } = await scanPages(FIXTURES_DIR);
    const app = new Elysia().use(createDataEndpoint(routes));

    const res = await app.handle(
      new Request(
        "http://localhost/_furin/data?path=%2Fquery-types%3Fpage%3D2%26active%3Dtrue%26tags%3Dreact%26tags%3Dfurin"
      )
    );

    expect(res.status).toBe(200);

    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );

    expect(syncData.query).toEqual({ active: true, page: 2, tags: ["react", "furin"] });
    expect(syncData.queryFromLoader).toEqual({
      active: true,
      page: 2,
      tags: ["react", "furin"],
    });
  });

  test("passes JSON object query values to loaders during SPA navigation", async () => {
    const { routes } = await scanPages(FIXTURES_DIR);
    const app = new Elysia().use(createDataEndpoint(routes));

    const res = await app.handle(
      new Request(
        `http://localhost/_furin/data?path=${encodeURIComponent(
          '/query-types?page=2&active=true&filter={"category":"framework"}'
        )}`
      )
    );

    expect(res.status).toBe(200);

    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );

    expect(syncData.query).toMatchObject({
      filter: { category: "framework" },
    });
    expect(syncData.queryFromLoader).toMatchObject({
      filter: { category: "framework" },
    });
  });

  test("rejects invalid schema query values before running loaders during SPA navigation", async () => {
    const { routes } = await scanPages(FIXTURES_DIR);
    const app = new Elysia().use(createDataEndpoint(routes));

    const res = await app.handle(
      new Request("http://localhost/_furin/data?path=%2Fquery-types%3Fpage%3Dnope%26active%3Dtrue")
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      message: "Invalid query",
      type: "validation",
    });
  });

  test("returns 404 if no route matches the path", async () => {
    const { routes } = await scanPages(FIXTURES_DIR);
    const app = new Elysia().use(createDataEndpoint(routes));

    const res = await app.handle(
      new Request("http://localhost/_furin/data?path=%2Froute-inexistante")
    );

    expect(res.status).toBe(404);
  });

  test("returns NDJSON for a route with a synchronous loader", async () => {
    const { routes } = await scanPages(FIXTURES_DIR);
    const withLoaderRoute = routes.find((r) => r.pattern === "/with-loader");
    if (!withLoaderRoute) {
      throw new Error("No /with-loader route in fixtures");
    }

    const app = new Elysia().use(createDataEndpoint(routes));
    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fwith-loader"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-furin-route");

    const { syncData, deferredPromises } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.pageData).toBe("from-page");
    expect(Object.keys(deferredPromises)).toHaveLength(0);
  });

  test("returns NDJSON with Promise for a route using defer()", async () => {
    const { routes } = await scanPages(FIXTURES_DIR);
    const deferRoute = routes.find((r) => r.pattern === "/defer-page");
    if (!deferRoute) {
      throw new Error("No /defer-page route in fixtures — add defer-page.tsx");
    }

    const app = new Elysia().use(createDataEndpoint(routes));
    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fdefer-page"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const { syncData, deferredPromises } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.title).toBe("deferred page");
    expect(deferredPromises.stats).toBeInstanceOf(Promise);
    const resolvedStats = await deferredPromises.stats;
    expect(resolvedStats).toBe(42);
  });

  test("returns the response before deferred Promises have resolved", async () => {
    const { routes } = await scanPages(FIXTURES_DIR);
    const deferRoute = routes.find((r) => r.pattern === "/defer-page");
    if (!deferRoute?.page) {
      throw new Error("No /defer-page route in fixtures — add defer-page.tsx");
    }

    // Replace `.page` with a shallow copy instead of mutating the shared
    // module export — `scanPages` returns routes whose `.page` is the cached
    // import, so in-place mutation would leak into other tests.
    deferRoute.page = {
      ...deferRoute.page,
      loader: () =>
        defer({
          stats: new Promise((resolve) => setTimeout(() => resolve(42), 50)),
          title: "deferred page",
        }),
    };

    const app = new Elysia().use(createDataEndpoint(routes));
    const responsePromise = app.handle(
      new Request("http://localhost/_furin/data?path=%2Fdefer-page")
    );

    // The handler must resolve BEFORE the 50ms deferred Promise settles —
    // racing against the delay is robust on slow CI, unlike a fixed sleep.
    const winner = await Promise.race([
      responsePromise.then(() => "handler" as const),
      delay(50).then(() => "deferred" as const),
    ]);
    expect(winner).toBe("handler");

    const res = await responsePromise;
    const { syncData, deferredPromises } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.title).toBe("deferred page");
    expect(deferredPromises.stats).toBeInstanceOf(Promise);
    expect(await deferredPromises.stats).toBe(42);
  });

  test("emits __furinTitle from the page head() for SPA navigation", async () => {
    // During SPA navigation the client fetches /_furin/data (NDJSON) — head()
    // never runs in the browser, so the endpoint must resolve the page title
    // server-side and ship it as the reserved __furinTitle field. Without this,
    // the client has to rely on a loader returning a magic `title` field.
    const { routes } = await scanPages(FIXTURES_DIR);
    const route = routes.find((r) => r.pattern === "/with-loader");
    if (!route) {
      throw new Error("No /with-loader route in fixtures");
    }
    // Shallow-copy `.page` rather than mutating the shared module export.
    route.page = {
      ...route.page,
      head: (ctx) => {
        const { pageData } = ctx as { pageData: string };
        return {
          meta: [{ title: `Page: ${pageData}` }],
        };
      },
    };

    const app = new Elysia().use(createDataEndpoint(routes));
    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fwith-loader"));

    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.__furinTitle).toBe("Page: from-page");
  });

  test("does not set __furinStatus for a route without a loader", async () => {
    // SSR route without loader doesn't trigger notFound.
    // We test the ssr-page which has no loader — data should be empty.
    const { routes } = await scanPages(FIXTURES_DIR);
    const ssrRoute = routes.find((r) => r.pattern === "/ssr-page");
    if (!ssrRoute) {
      throw new Error("No /ssr-page route in fixtures");
    }

    const app = new Elysia().use(createDataEndpoint(routes));
    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fssr-page"));

    expect(res.status).toBe(200);
    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    // No special fields — just empty data
    expect(syncData.__furinStatus).toBeUndefined();
  });

  test("returns params in NDJSON for dynamic routes", async () => {
    const { routes } = await scanPages(FIXTURES_DIR);
    const app = new Elysia().use(createDataEndpoint(routes));

    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fdynamic%2F42"));

    expect(res.status).toBe(200);
    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.params).toEqual({ id: "42" });
    expect(syncData.path).toBe("/dynamic/42");
  });

  test("prefers a static route over a dynamic sibling that also matches", async () => {
    // `/dynamic/specific` (static) and `/dynamic/:id` (dynamic) both match the
    // path `/dynamic/specific`. The endpoint must pick the static route — the
    // dynamic one would otherwise shadow it (its dir `[id]` is scanned first).
    const { routes } = await scanPages(FIXTURES_DIR);
    const app = new Elysia().use(createDataEndpoint(routes));

    const res = await app.handle(
      new Request("http://localhost/_furin/data?path=%2Fdynamic%2Fspecific")
    );

    expect(res.status).toBe(200);
    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.pageData).toBe("from-static-specific");
    // The dynamic route would have produced a `params.id` — the static one has none.
    expect(syncData.params).toEqual({});
  });

  test("layout loader returning defer() streams its deferred field through the NDJSON endpoint", async () => {
    const { routes } = await scanPages(FIXTURES_DIR);
    const route = routes.find((r) => r.pattern === "/with-loader");
    if (!route) {
      throw new Error("No /with-loader route in fixtures");
    }
    const layoutEntry = route.routeChain.find((r) => Boolean(r.loader));
    if (!layoutEntry) {
      throw new Error("No layout loader in /with-loader routeChain");
    }
    // Shallow-copy the routeChain entry so the deferred loader does not leak
    // into other tests sharing the same scanPages cache.
    const patched = {
      ...layoutEntry,
      loader: () =>
        defer({
          asyncWidget: new Promise((resolve) =>
            setTimeout(() => resolve(["item-a", "item-b"]), 20)
          ),
          layoutData: "from-layout-defer",
        }),
    };
    route.routeChain = route.routeChain.map((r) => (r === layoutEntry ? patched : r));

    const app = new Elysia().use(createDataEndpoint(routes));
    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fwith-loader"));

    expect(res.status).toBe(200);
    const { syncData, deferredPromises } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.layoutData).toBe("from-layout-defer");
    expect(deferredPromises.asyncWidget).toBeInstanceOf(Promise);
    expect(await deferredPromises.asyncWidget).toEqual(["item-a", "item-b"]);
  });

  test("layout defer + page defer → both deferred Promises arrive as separate NDJSON chunks", async () => {
    const { routes } = await scanPages(FIXTURES_DIR);
    const route = routes.find((r) => r.pattern === "/with-loader");
    if (!route?.page) {
      throw new Error("No /with-loader route in fixtures");
    }
    const layoutEntry = route.routeChain.find((r) => Boolean(r.loader));
    if (!layoutEntry) {
      throw new Error("No layout loader in /with-loader routeChain");
    }
    const patchedLayout = {
      ...layoutEntry,
      loader: () =>
        defer({
          asyncWidget: new Promise((resolve) => setTimeout(() => resolve("widget-ok"), 10)),
          layoutData: "from-layout",
        }),
    };
    route.routeChain = route.routeChain.map((r) => (r === layoutEntry ? patchedLayout : r));
    route.page = {
      ...route.page,
      loader: () =>
        defer({
          asyncStats: new Promise((resolve) => setTimeout(() => resolve(99), 15)),
          pageData: "from-page",
        }),
    };

    const app = new Elysia().use(createDataEndpoint(routes));
    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fwith-loader"));

    expect(res.status).toBe(200);
    const text = await new Response(res.body).text();
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    // Line 0 is the initial sync payload. Subsequent lines are resolution chunks
    // — one per deferred field, regardless of which loader produced it.
    const resolutionKeys = lines.slice(1).map((line) => (JSON.parse(line) as { key: string }).key);
    expect(resolutionKeys.sort()).toEqual(["asyncStats", "asyncWidget"]);
  });

  test("emits chunks in resolution order, not insertion order", async () => {
    // 'slow' is inserted FIRST in defer() but resolves LAST. 'fast' is inserted
    // SECOND but resolves FIRST. The on-the-wire stream MUST emit the fast key
    // first — otherwise streaming is cosmetic and a fast field is held hostage
    // by a slow sibling. This is the whole reason defer() exists.
    const { routes } = await scanPages(FIXTURES_DIR);
    const deferRoute = routes.find((r) => r.pattern === "/defer-page");
    if (!deferRoute?.page) {
      throw new Error("No /defer-page route in fixtures");
    }
    // Shallow-copy `.page` rather than mutating the shared module export.
    deferRoute.page = {
      ...deferRoute.page,
      loader: () =>
        defer({
          fast: new Promise((resolve) => setTimeout(() => resolve("fast-value"), 10)),
          slow: new Promise((resolve) => setTimeout(() => resolve("slow-value"), 80)),
          title: "deferred page",
        }),
    };

    const app = new Elysia().use(createDataEndpoint(routes));
    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fdefer-page"));

    const text = await new Response(res.body).text();
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    // Line 0 is the initial sync payload, lines 1+ are resolution chunks.
    const resolutionKeys = lines.slice(1).map((line) => (JSON.parse(line) as { key: string }).key);

    expect(resolutionKeys).toEqual(["fast", "slow"]);
  });

  test("defer() on a dynamic route: params are in syncData and deferred Promises stream", async () => {
    const { routes } = await scanPages(FIXTURES_DIR);
    const app = new Elysia().use(createDataEndpoint(routes));

    const res = await app.handle(
      new Request("http://localhost/_furin/data?path=%2Fdynamic-defer%2Fhello-world")
    );

    expect(res.status).toBe(200);
    const { syncData, deferredPromises } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    // Sync scalar fields (including route ctx + the `slug` field returned by
    // the page loader) are immediately available.
    expect(syncData.params).toEqual({ slug: "hello-world" });
    expect(syncData.path).toBe("/dynamic-defer/hello-world");
    expect(syncData.slug).toBe("hello-world");
    // The deferred field arrives as a Promise that settles via the NDJSON
    // resolution chunk.
    expect(deferredPromises.post).toBeInstanceOf(Promise);
    expect(await deferredPromises.post).toEqual({ title: "Post for hello-world" });
  });

  // ── Slice 3 — SPA error sentinel ───────────────────────────────────────────
  test("loader throwing Response(403) returns HTTP 403 with __furinError NDJSON sentinel", async () => {
    const { routes } = await scanPages(FIXTURES_DIR);
    const route = routes.find((r) => r.pattern === "/with-loader");
    if (!route) {
      throw new Error("No /with-loader route in fixtures");
    }
    // Shallow-copy `.page` so the throwing loader does not leak to other tests.
    route.page = {
      ...route.page,
      loader: () => {
        throw new Response("Forbidden", { status: 403 });
      },
    };

    const app = new Elysia().use(createDataEndpoint(routes));
    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fwith-loader"));

    // The HTTP status of the data response matches the loader's Response.status —
    // browsers and monitoring see the right code.
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    const furinError = syncData.__furinError as
      | { status: number; message: string; digest: string }
      | undefined;
    expect(furinError).toBeDefined();
    expect(furinError?.status).toBe(403);
    expect(furinError?.message).toBe("Forbidden");
    // Digest is a 10-hex-char string correlating with server logs.
    expect(furinError?.digest).toMatch(DIGEST_RE);
  });

  test("loader throwing plain Error returns HTTP 500 with __furinError NDJSON sentinel", async () => {
    const { routes } = await scanPages(FIXTURES_DIR);
    const route = routes.find((r) => r.pattern === "/with-loader");
    if (!route) {
      throw new Error("No /with-loader route in fixtures");
    }
    // Shallow-copy `.page` so the throwing loader does not leak to other tests.
    route.page = {
      ...route.page,
      loader: () => {
        throw new Error("kaboom");
      },
    };

    const app = new Elysia().use(createDataEndpoint(routes));
    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fwith-loader"));

    expect(res.status).toBe(500);
    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    const furinError = syncData.__furinError as
      | { status: number; message: string; digest: string }
      | undefined;
    expect(furinError).toBeDefined();
    expect(furinError?.status).toBe(500);
    // Original error message MUST NOT leak — generic public message instead.
    expect(furinError?.message).toBe("Something went wrong");
    expect(furinError?.message).not.toContain("kaboom");
    expect(furinError?.digest).toMatch(DIGEST_RE);
  });
});
