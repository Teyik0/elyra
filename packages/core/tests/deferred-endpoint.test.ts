import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

mock.module("evlog/elysia", () => ({
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
  useLogger: () => ({ set() {} }),
  evlog: () => (app: unknown) => app,
}));
mock.module("evlog", () => ({
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stubs
  log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
  initLogger: () => {},
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stubs
  useLogger: () => ({ set() {}, info() {}, warn() {}, error() {} }),
}));

import { Elysia } from "elysia";
import { defer } from "../src/client";
import { parseDeferredNdjson } from "../src/deferred-ndjson";
import { createDataEndpoint, scanPages } from "../src/router";
import { __setDevMode, IS_DEV } from "../src/runtime-env";

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
  test("retourne 400 si le paramètre path est absent", async () => {
    const { routes } = await scanPages(FIXTURES_DIR);
    const app = new Elysia().use(createDataEndpoint(routes));

    const res = await app.handle(new Request("http://localhost/_furin/data"));

    expect(res.status).toBe(400);
  });

  test("rejette une URL absolue passée dans ?path= (open-redirect prevention)", async () => {
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

  test("rejette un path protocol-relative `//host/foo`", async () => {
    const { routes } = await scanPages(FIXTURES_DIR);
    const app = new Elysia().use(createDataEndpoint(routes));

    const res = await app.handle(
      new Request("http://localhost/_furin/data?path=%2F%2Fevil.com%2Ffoo")
    );

    expect(res.status).toBe(400);
  });

  test("émet le sentinel NDJSON __furinRedirect quand un défaut de query est appliqué", async () => {
    // Regression: previously the query-default redirect returned an HTTP 302
    // (Response) directly from the handler. The SPA client reads NDJSON via
    // `parseDeferredNdjson` — a 302 is unparseable and would crash the
    // navigation pipeline. The endpoint must now produce an NDJSON document
    // carrying the `__furinRedirect` sentinel instead.
    const { routes } = await scanPages(FIXTURES_DIR);
    const app = new Elysia().use(createDataEndpoint(routes));

    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fquery-default"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.__furinRedirect).toBe("/query-default?city=Paris");
  });

  test("retourne 404 si aucune route ne correspond au path", async () => {
    const { routes } = await scanPages(FIXTURES_DIR);
    const app = new Elysia().use(createDataEndpoint(routes));

    const res = await app.handle(
      new Request("http://localhost/_furin/data?path=%2Froute-inexistante")
    );

    expect(res.status).toBe(404);
  });

  test("retourne NDJSON pour une route avec loader synchrone", async () => {
    const { routes } = await scanPages(FIXTURES_DIR);
    const withLoaderRoute = routes.find((r) => r.pattern === "/with-loader");
    if (!withLoaderRoute) {
      throw new Error("No /with-loader route in fixtures");
    }

    const app = new Elysia().use(createDataEndpoint(routes));
    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fwith-loader"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const { syncData, deferredPromises } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.pageData).toBe("from-page");
    expect(Object.keys(deferredPromises)).toHaveLength(0);
  });

  test("retourne NDJSON avec Promise pour une route utilisant defer()", async () => {
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

  test("retourne la réponse avant que les Promises deferred soient résolues", async () => {
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
          title: "deferred page",
          stats: new Promise((resolve) => setTimeout(() => resolve(42), 50)),
        }),
    };

    const app = new Elysia().use(createDataEndpoint(routes));
    const responsePromise = app.handle(
      new Request("http://localhost/_furin/data?path=%2Fdefer-page")
    );

    let responseReturned = false;
    responsePromise.then(() => {
      responseReturned = true;
    });
    await delay(10);
    expect(responseReturned).toBe(true);

    const res = await responsePromise;
    const { syncData, deferredPromises } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.title).toBe("deferred page");
    expect(deferredPromises.stats).toBeInstanceOf(Promise);
    expect(await deferredPromises.stats).toBe(42);
  });

  test("émet __furinTitle depuis le head() de la page pour la navigation SPA", async () => {
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
      head: ({ pageData }: { pageData: string }) => ({
        meta: [{ title: `Page: ${pageData}` }],
      }),
    };

    const app = new Elysia().use(createDataEndpoint(routes));
    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fwith-loader"));

    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.__furinTitle).toBe("Page: from-page");
  });

  test("ne définit pas __furinStatus pour une route sans loader", async () => {
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

  test("émet les chunks dans l'ordre de résolution, pas dans l'ordre d'insertion", async () => {
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
          title: "deferred page",
          slow: new Promise((resolve) => setTimeout(() => resolve("slow-value"), 80)),
          fast: new Promise((resolve) => setTimeout(() => resolve("fast-value"), 10)),
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
