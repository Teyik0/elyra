/**
 * Tests for `runLoaders` Response classification.
 *
 * The contract under test:
 * - 3xx WITH Location header → `{ type: "redirect" }`
 * - 3xx WITHOUT Location → `{ type: "error", status: 500 }` (developer mistake;
 *   3xx without Location is invalid HTTP, surfacing as error is more debuggable)
 * - 4xx / 5xx → `{ type: "error", status: <res.status>, message: <body|statusText> }`
 * - `notFound()` → `{ type: "not-found" }` (unchanged)
 * - thrown `Error` / non-Error → `{ type: "error", status: 500 }` (regression)
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

mock.module("evlog/elysia", () => ({
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
  useLogger: () => ({ set() {} }),
  evlog: () => (app: unknown) => app,
}));

import type { Context } from "elysia";
import type { HTTPHeaders } from "elysia/types";
import { notFound } from "../src/not-found";
import { runLoaders } from "../src/render/loaders";
import type { ResolvedRoute } from "../src/router";
import { scanPages } from "../src/router";
import { __setDevMode, IS_DEV } from "../src/runtime-env";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures/pages");

function createMockLoaderContext(overrides: Partial<Context>): Context {
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

async function getRoute(pattern: string): Promise<ResolvedRoute> {
  const result = await scanPages(FIXTURES_DIR);
  const route = result.routes.find((r) => r.pattern === pattern);
  if (!route) {
    throw new Error(`Route ${pattern} not found`);
  }
  return route;
}

async function getRoot() {
  return (await scanPages(FIXTURES_DIR)).root;
}

function withLoader(route: ResolvedRoute, loader: () => unknown): ResolvedRoute {
  return {
    ...route,
    page: {
      ...route.page,
      loader,
    },
  } as ResolvedRoute;
}

const originalDevMode = IS_DEV;
beforeAll(() => __setDevMode(false));
afterAll(() => __setDevMode(originalDevMode));

describe("runLoaders — thrown Response classification", () => {
  test("Response(404) is classified as type: error with status 404", async () => {
    const baseRoute = await getRoute("/with-loader");
    const root = await getRoot();
    const route = withLoader(baseRoute, () => {
      throw new Response(null, { status: 404 });
    });

    const result = await runLoaders(
      route,
      createMockLoaderContext({ path: "/with-loader" }),
      root.route
    );

    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.status).toBe(404);
    }
  });

  test("Response(500) with body surfaces the body as the public message", async () => {
    const baseRoute = await getRoute("/with-loader");
    const root = await getRoot();
    const route = withLoader(baseRoute, () => {
      throw new Response("oops", { status: 500 });
    });

    const result = await runLoaders(
      route,
      createMockLoaderContext({ path: "/with-loader" }),
      root.route
    );

    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.status).toBe(500);
      expect(result.message).toBe("oops");
    }
  });

  test("Response(302) with Location is classified as redirect", async () => {
    const baseRoute = await getRoute("/with-loader");
    const root = await getRoot();
    const route = withLoader(baseRoute, () => {
      throw new Response(null, { status: 302, headers: { Location: "/x" } });
    });

    const result = await runLoaders(
      route,
      createMockLoaderContext({ path: "/with-loader" }),
      root.route
    );

    expect(result.type).toBe("redirect");
    if (result.type === "redirect") {
      expect(result.response.headers.get("location")).toBe("/x");
    }
  });

  test("Response(302) without Location is classified as error 500 (invalid redirect)", async () => {
    const baseRoute = await getRoute("/with-loader");
    const root = await getRoot();
    const route = withLoader(baseRoute, () => {
      throw new Response(null, { status: 302 });
    });

    const result = await runLoaders(
      route,
      createMockLoaderContext({ path: "/with-loader" }),
      root.route
    );

    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.status).toBe(500);
    }
  });

  test("Response(401) without body falls back to a generic public message", async () => {
    const baseRoute = await getRoute("/with-loader");
    const root = await getRoot();
    const route = withLoader(baseRoute, () => {
      throw new Response(null, { status: 401 });
    });

    const result = await runLoaders(
      route,
      createMockLoaderContext({ path: "/with-loader" }),
      root.route
    );

    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.status).toBe(401);
      // Bodyless Response() sets statusText="" by default — fall back to the
      // generic message so the error UI never shows an empty string.
      expect(result.message).toBe("Something went wrong");
    }
  });

  test("notFound() is still classified as type: not-found (regression)", async () => {
    const baseRoute = await getRoute("/with-loader");
    const root = await getRoot();
    const route = withLoader(baseRoute, () => {
      notFound({ message: "x" });
    });

    const result = await runLoaders(
      route,
      createMockLoaderContext({ path: "/with-loader" }),
      root.route
    );

    expect(result.type).toBe("not-found");
  });

  test("plain Error is classified as type: error with status 500 (regression)", async () => {
    const baseRoute = await getRoute("/with-loader");
    const root = await getRoot();
    const route = withLoader(baseRoute, () => {
      throw new Error("boom");
    });

    const result = await runLoaders(
      route,
      createMockLoaderContext({ path: "/with-loader" }),
      root.route
    );

    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.status).toBe(500);
      expect(result.message).toBe("Something went wrong");
      expect((result.error as Error).message).toBe("boom");
    }
  });
});
