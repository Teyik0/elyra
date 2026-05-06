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
import { parseDeferredNdjson } from "../src/deferred-ndjson";
import { createDataEndpoint, scanPages } from "../src/router";
import { __setDevMode, IS_DEV } from "../src/runtime-env";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures/pages");
const DIGEST_RE = /^[0-9a-f]{10}$/;

let originalDevMode: boolean;
beforeAll(() => {
  originalDevMode = IS_DEV;
  __setDevMode(false);
});
afterAll(() => __setDevMode(originalDevMode));

describe("GET /_furin/data", () => {
  test("retourne 400 si le paramètre path est absent", async () => {
    const { root, routes } = await scanPages(FIXTURES_DIR);
    const app = new Elysia().use(createDataEndpoint(routes, root));

    const res = await app.handle(new Request("http://localhost/_furin/data"));

    expect(res.status).toBe(400);
  });

  test("retourne 404 si aucune route ne correspond au path", async () => {
    const { root, routes } = await scanPages(FIXTURES_DIR);
    const app = new Elysia().use(createDataEndpoint(routes, root));

    const res = await app.handle(
      new Request("http://localhost/_furin/data?path=%2Froute-inexistante")
    );

    expect(res.status).toBe(404);
  });

  test("retourne NDJSON pour une route avec loader synchrone", async () => {
    const { root, routes } = await scanPages(FIXTURES_DIR);
    const withLoaderRoute = routes.find((r) => r.pattern === "/with-loader");
    if (!withLoaderRoute) {
      throw new Error("No /with-loader route in fixtures");
    }

    const app = new Elysia().use(createDataEndpoint(routes, root));
    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fwith-loader"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const { syncData, deferredPromises } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() })
    );
    expect(syncData.pageData).toBe("from-page");
    expect(Object.keys(deferredPromises)).toHaveLength(0);
  });

  test("retourne NDJSON avec Promise pour une route utilisant defer()", async () => {
    const { root, routes } = await scanPages(FIXTURES_DIR);
    const deferRoute = routes.find((r) => r.pattern === "/defer-page");
    if (!deferRoute) {
      throw new Error("No /defer-page route in fixtures — add defer-page.tsx");
    }

    const app = new Elysia().use(createDataEndpoint(routes, root));
    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fdefer-page"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const { syncData, deferredPromises } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() })
    );
    expect(syncData.title).toBe("deferred page");
    expect(deferredPromises.stats).toBeInstanceOf(Promise);
    const resolvedStats = await deferredPromises.stats;
    expect(resolvedStats).toBe(42);
  });

  test("ne définit pas __furinStatus pour une route sans loader", async () => {
    // SSR route without loader doesn't trigger notFound.
    // We test the ssr-page which has no loader — data should be empty.
    const { root, routes } = await scanPages(FIXTURES_DIR);
    const ssrRoute = routes.find((r) => r.pattern === "/ssr-page");
    if (!ssrRoute) {
      throw new Error("No /ssr-page route in fixtures");
    }

    const app = new Elysia().use(createDataEndpoint(routes, root));
    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fssr-page"));

    expect(res.status).toBe(200);
    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() })
    );
    // No special fields — just empty data
    expect(syncData.__furinStatus).toBeUndefined();
  });

  test("returns params in NDJSON for dynamic routes", async () => {
    const { root, routes } = await scanPages(FIXTURES_DIR);
    const app = new Elysia().use(createDataEndpoint(routes, root));

    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fdynamic%2F42"));

    expect(res.status).toBe(200);
    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() })
    );
    expect(syncData.params).toEqual({ id: "42" });
    expect(syncData.path).toBe("/dynamic/42");
  });

  // ── Slice 3 — SPA error sentinel ───────────────────────────────────────────
  test("loader throwing Response(403) returns HTTP 403 with __furinError NDJSON sentinel", async () => {
    const { root, routes } = await scanPages(FIXTURES_DIR);
    const route = routes.find((r) => r.pattern === "/with-loader");
    if (!route) {
      throw new Error("No /with-loader route in fixtures");
    }
    // Patch the loader in-place to throw a non-redirect Response.
    route.page.loader = () => {
      throw new Response("Forbidden", { status: 403 });
    };

    const app = new Elysia().use(createDataEndpoint(routes, root));
    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fwith-loader"));

    // The HTTP status of the data response matches the loader's Response.status —
    // browsers and monitoring see the right code.
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() })
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
    const { root, routes } = await scanPages(FIXTURES_DIR);
    const route = routes.find((r) => r.pattern === "/with-loader");
    if (!route) {
      throw new Error("No /with-loader route in fixtures");
    }
    route.page.loader = () => {
      throw new Error("kaboom");
    };

    const app = new Elysia().use(createDataEndpoint(routes, root));
    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fwith-loader"));

    expect(res.status).toBe(500);
    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() })
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
