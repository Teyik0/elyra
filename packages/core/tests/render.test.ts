import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { HTTPHeaders } from "elysia/types";
import {
  buildElement,
  handleISR,
  type LoaderContext,
  prerenderSSG,
  renderSSR,
  runLoaders,
} from "../src/render";
import type { ResolvedRoute, RootLayout } from "../src/router";
import { scanPages } from "../src/router";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures/pages");

function createMockLoaderContext(overrides: Partial<LoaderContext> = {}): LoaderContext {
  return {
    params: {},
    query: {},
    request: new Request("http://localhost/test"),
    headers: {},
    cookie: {},
    redirect: (url) => new Response(null, { status: 302, headers: { Location: url } }),
    set: { headers: {} as HTTPHeaders },
    path: "/test",
    ...overrides,
  };
}

async function getRoute(pattern: string): Promise<ResolvedRoute> {
  const result = await scanPages(FIXTURES_DIR);
  const route = result.routes.find((r) => r.pattern === pattern);
  if (!route) {
    throw new Error(`Route ${pattern} not found`);
  }
  return route;
}

async function getRoot(): Promise<RootLayout> {
  const result = await scanPages(FIXTURES_DIR);
  if (!result.root) {
    throw new Error("Root not found");
  }
  return result.root;
}

describe("render.tsx", () => {
  describe("runLoaders", () => {
    test("returns data result for SSR route", async () => {
      const ssrRoute = await getRoute("/ssr-page");
      const root = await getRoot();
      const rootLayout = root.route;
      const ctx = createMockLoaderContext({ path: "/ssr-page" });

      const result = await runLoaders(ssrRoute, ctx, rootLayout);

      expect(result.type).toBe("data");
    });

    test("returns data result for route with loader", async () => {
      const withLoaderRoute = await getRoute("/with-loader");
      const root = await getRoot();
      const rootLayout = root.route;
      const ctx = createMockLoaderContext({ path: "/with-loader" });

      const result = await runLoaders(withLoaderRoute, ctx, rootLayout);

      expect(result.type).toBe("data");
      if (result.type === "data") {
        expect(result.data.layoutData).toBe("from-layout");
        expect(result.data.pageData).toBe("from-page");
      }
    });

    test("captures headers set by loader", async () => {
      const withLoaderRoute = await getRoute("/with-loader");
      const root = await getRoot();
      const rootLayout = root.route;
      const ctx = createMockLoaderContext({ path: "/with-loader" });

      const result = await runLoaders(withLoaderRoute, ctx, rootLayout);

      expect(result.type).toBe("data");
      if (result.type === "data") {
        expect(result.headers["x-loader-ran"]).toBe("true");
      }
    });

    test("returns redirect result when loader throws Response", async () => {
      const ssrRoute = await getRoute("/ssr-page");
      const root = await getRoot();
      const rootLayout = root.route;

      const redirectMock = (url: string) =>
        new Response(null, { status: 302, headers: { Location: url } });
      const ctx = createMockLoaderContext({ redirect: redirectMock });

      const customRoute = {
        ...ssrRoute,
        page: {
          ...ssrRoute.page,
          loader: (loaderCtx: Record<string, unknown>) => {
            const redirect = loaderCtx.redirect as (url: string) => Response;
            throw redirect("/login");
          },
        },
      } as ResolvedRoute;

      const result = await runLoaders(customRoute, ctx, rootLayout);

      expect(result.type).toBe("redirect");
      if (result.type === "redirect") {
        expect(result.response.status).toBe(302);
      }
    });

    test("re-throws non-Response errors", async () => {
      const ssrRoute = await getRoute("/ssr-page");
      const customRoute = {
        ...ssrRoute,
        page: {
          ...ssrRoute.page,
          loader: () => {
            throw new Error("Loader error");
          },
        },
      } as ResolvedRoute;
      const ctx = createMockLoaderContext();

      expect(runLoaders(customRoute, ctx, undefined)).rejects.toThrow("Loader error");
    });
  });

  describe("buildElement", () => {
    test("wraps component with root layout", async () => {
      const ssrRoute = await getRoute("/ssr-page");
      const root = await getRoot();
      const rootLayout = root.route;

      if (!ssrRoute.page) {
        throw new Error("page not loaded");
      }
      const element = buildElement(ssrRoute, ssrRoute.page, {}, rootLayout);
      expect(element).toBeDefined();
    });

    test("works without root layout", async () => {
      const ssrRoute = await getRoute("/ssr-page");

      if (!ssrRoute.page) {
        throw new Error("page not loaded");
      }
      const element = buildElement(ssrRoute, ssrRoute.page, {}, undefined);
      expect(element).toBeDefined();
    });

    test("wraps component with nested route chain layouts", async () => {
      const nestedRoute = await getRoute("/nested/deep");
      const root = await getRoot();
      const rootLayout = root.route;

      if (!nestedRoute.page) {
        throw new Error("page not loaded");
      }
      const element = buildElement(nestedRoute, nestedRoute.page, {}, rootLayout);
      expect(element).toBeDefined();
    });
  });

  describe("prerenderSSG", () => {
    test("renders to non-empty HTML string", async () => {
      const indexRoute = await getRoute("/");
      const root = await getRoot();

      const html = await prerenderSSG(indexRoute, {}, root, false);
      expect(typeof html).toBe("string");
      expect(html.length).toBeGreaterThan(0);
    });

    test("returns cached HTML on second call", async () => {
      const ssgRoute = await getRoute("/ssg-page");
      const root = await getRoot();

      const html1 = await prerenderSSG(ssgRoute, {}, root, false);
      const html2 = await prerenderSSG(ssgRoute, {}, root, false);

      expect(html1).toBe(html2);
    });

    test("renders with root layout when root is provided", async () => {
      const indexRoute = await getRoute("/");
      const root = await getRoot();

      const html = await prerenderSSG(indexRoute, {}, root, false);
      expect(html).toContain("root-layout");
    });

    test("skips cache in dev mode", async () => {
      const indexRoute = await getRoute("/");
      const root = await getRoot();

      const html1 = await prerenderSSG(indexRoute, {}, root, true);
      expect(html1.length).toBeGreaterThan(0);
    });
  });

  describe("renderSSR", () => {
    test("returns Response with HTML", async () => {
      const ssrRoute = await getRoute("/ssr-page");
      const root = await getRoot();

      const ctx = createMockLoaderContext({ path: "/ssr-page" });
      const response = await renderSSR(ssrRoute, ctx, root, false);

      expect(response).toBeInstanceOf(Response);
      const html = await response.text();
      expect(html.length).toBeGreaterThan(0);
    });

    test("sets correct headers (no-cache)", async () => {
      const ssrRoute = await getRoute("/ssr-page");
      const root = await getRoot();

      const ctx = createMockLoaderContext({ path: "/ssr-page" });
      const response = await renderSSR(ssrRoute, ctx, root, false);

      expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");
    });

    test("propagates headers set by loader", async () => {
      const withLoaderRoute = await getRoute("/with-loader");
      const root = await getRoot();

      const ctx = createMockLoaderContext({ path: "/with-loader" });
      const response = await renderSSR(withLoaderRoute, ctx, root, false);

      expect(response.headers.get("x-loader-ran")).toBe("true");
    });

    test("returns redirect Response when loader throws redirect", async () => {
      const ssrRoute = await getRoute("/ssr-page");
      const root = await getRoot();

      const redirectMock = (url: string) =>
        new Response(null, { status: 302, headers: { Location: url } });
      const ctx = createMockLoaderContext({
        path: "/ssr-page",
        redirect: redirectMock,
      });

      const customRoute = {
        ...ssrRoute,
        page: {
          ...ssrRoute.page,
          loader: (loaderCtx: Record<string, unknown>) => {
            const redirect = loaderCtx.redirect as (url: string) => Response;
            throw redirect("/login");
          },
        },
      } as ResolvedRoute;

      const response = await renderSSR(customRoute, ctx, root, false);

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/login");
    });
  });

  describe("handleISR", () => {
    test("renders and returns Response with HTML", async () => {
      const isrRoute = await getRoute("/isr-page");
      const root = await getRoot();

      const ctx = createMockLoaderContext({ path: "/isr-page" });
      const response = await handleISR(isrRoute, ctx, root, false);
      const html = await response.text();

      expect(html.length).toBeGreaterThan(0);
      expect(html).toContain("isr-page");
    });

    test("sets correct Cache-Control headers", async () => {
      const isrRoute = await getRoute("/isr-page");
      const root = await getRoot();

      const ctx = createMockLoaderContext({ path: "/isr-page" });
      const response = await handleISR(isrRoute, ctx, root, false);

      const cacheControl = response.headers.get("Cache-Control");
      expect(cacheControl).toContain("public");
      expect(cacheControl).toContain("s-maxage=60");
    });

    test("returns cached HTML on second call (ISR cache)", async () => {
      const isrRoute = await getRoute("/isr-page");
      const root = await getRoot();

      const ctx = createMockLoaderContext({ path: "/isr-page" });
      // First call populates the cache
      const response1 = await handleISR(isrRoute, ctx, root, false);
      const html1 = await response1.text();
      // Second call should hit the cache (same timestamp in isr-page loader)
      const response2 = await handleISR(isrRoute, ctx, root, false);
      const html2 = await response2.text();

      // Both should be valid HTML
      expect(html1.length).toBeGreaterThan(0);
      expect(html2.length).toBeGreaterThan(0);
      // Second call returns cached version — same HTML
      expect(html1).toBe(html2);
    });
  });

  describe("resolvePath (indirect)", () => {
    test("used by prerenderSSG to resolve pattern", async () => {
      const indexRoute = await getRoute("/");
      const root = await getRoot();

      const html = await prerenderSSG(indexRoute, {}, root, false);
      expect(typeof html).toBe("string");
      expect(html.length).toBeGreaterThan(0);
    });
  });
});
