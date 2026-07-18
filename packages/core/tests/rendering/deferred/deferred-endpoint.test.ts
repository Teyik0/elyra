import { describe, expect, test } from "bun:test";
import "../../setup/evlog-mock";

import { Elysia, t } from "elysia";
import { createRoute, defer } from "../../../src/client";
import type { RuntimePage, RuntimeRoute } from "../../../src/client/internal/runtime-types.ts";
import type { ResolvedRoute } from "../../../src/server/router/index.ts";
import { createDataEndpoint } from "../../../src/server/router/index.ts";
import { __setDevMode } from "../../../src/server/runtime-env.ts";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";

const DIGEST_RE = /^[0-9a-f]{10}$/;

function cloneResolvedRoute(route: ResolvedRoute): ResolvedRoute {
  const cloned: ResolvedRoute = {
    ...route,
    page: { ...route.page },
    routeChain: route.routeChain.map((entry) => ({ ...entry })),
    segmentBoundaries: route.segmentBoundaries.map((boundary) => ({ ...boundary })),
  };
  if (route.isrCache !== undefined) {
    cloned.isrCache = { ...route.isrCache };
  }
  if (route.tags !== undefined) {
    cloned.tags = [...route.tags];
  }
  return cloned;
}

function runtimeRoute(route: unknown): RuntimeRoute {
  return route as RuntimeRoute;
}

function runtimePage(page: unknown): RuntimePage {
  return page as RuntimePage;
}

const rootRoute = createRoute({
  layout: ({ children }) => children,
});

const queryDefaultRoute = createRoute({
  parent: rootRoute,
  query: t.Object({
    city: t.Optional(t.String({ default: "Paris" })),
  }),
});

const queryTypesRoute = createRoute({
  parent: rootRoute,
  query: t.Object({
    active: t.Boolean(),
    filter: t.Optional(t.Object({ category: t.String() })),
    page: t.Number(),
    tags: t.Optional(t.Array(t.String())),
  }),
});

const withLoaderRouteDefinition = createRoute({
  loader: ({ cookie, headers, path, request, set }) => {
    set.headers["x-loader-ran"] = "true";
    return {
      cookieValue: cookie.test?.value as string | undefined,
      currentPath: path,
      hasHeaders: Boolean(headers),
      layoutData: "from-layout",
      requestUrl: request.url,
    };
  },
  parent: rootRoute,
});

const deferRouteDefinition = createRoute({
  mode: "ssr",
  parent: rootRoute,
});

const ssrRouteDefinition = createRoute({
  mode: "ssr",
  parent: rootRoute,
});

const dynamicRoute = createRoute({
  params: t.Object({ id: t.String() }),
  parent: rootRoute,
});

const numericParamRoute = createRoute({
  params: t.Object({ id: t.Number() }),
  parent: rootRoute,
});

const staticSpecificRoute = createRoute({
  mode: "ssr",
  parent: rootRoute,
});

const accountRoute = createRoute({
  mode: "ssr",
  parent: rootRoute,
});

const dynamicDeferRoute = createRoute({
  params: t.Object({ slug: t.String() }),
  parent: rootRoute,
});

const BASE_ROUTES: ResolvedRoute[] = [
  {
    mode: "ssr",
    page: runtimePage(queryDefaultRoute.page({ component: () => null })),
    path: "/query-default",
    pattern: "/query-default",
    routeChain: [runtimeRoute(rootRoute), runtimeRoute(queryDefaultRoute)],
    segmentBoundaries: [],
  },
  {
    mode: "ssr",
    page: runtimePage(
      queryTypesRoute.page({
        component: () => null,
        loader: ({ query }) => ({ queryFromLoader: query }),
      })
    ),
    path: "/query-types",
    pattern: "/query-types",
    routeChain: [runtimeRoute(rootRoute), runtimeRoute(queryTypesRoute)],
    segmentBoundaries: [],
  },
  {
    mode: "ssr",
    page: runtimePage(
      withLoaderRouteDefinition.page({
        component: () => null,
        loader: async () => ({ pageData: "from-page" }),
      })
    ),
    path: "/with-loader",
    pattern: "/with-loader",
    routeChain: [runtimeRoute(rootRoute), runtimeRoute(withLoaderRouteDefinition)],
    segmentBoundaries: [],
  },
  {
    mode: "ssr",
    page: runtimePage(
      deferRouteDefinition.page({
        component: () => null,
        loader: async () =>
          defer({
            stats: Promise.resolve(42),
            title: "deferred page",
          }),
      })
    ),
    path: "/defer-page",
    pattern: "/defer-page",
    routeChain: [runtimeRoute(rootRoute), runtimeRoute(deferRouteDefinition)],
    segmentBoundaries: [],
  },
  {
    mode: "ssr",
    page: runtimePage(ssrRouteDefinition.page({ component: () => null })),
    path: "/ssr-page",
    pattern: "/ssr-page",
    routeChain: [runtimeRoute(rootRoute), runtimeRoute(ssrRouteDefinition)],
    segmentBoundaries: [],
  },
  {
    mode: "ssr",
    page: runtimePage(
      dynamicRoute.page({
        component: () => null,
        loader: () => ({ pageData: "from-dynamic" }),
      })
    ),
    path: "/dynamic/[id]",
    pattern: "/dynamic/:id",
    routeChain: [runtimeRoute(rootRoute), runtimeRoute(dynamicRoute)],
    segmentBoundaries: [],
  },
  {
    mode: "ssr",
    page: runtimePage(
      numericParamRoute.page({
        component: () => null,
        loader: ({ params }) => ({ paramsFromLoader: params }),
      })
    ),
    path: "/number/[id]",
    pattern: "/number/:id",
    routeChain: [runtimeRoute(rootRoute), runtimeRoute(numericParamRoute)],
    segmentBoundaries: [],
  },
  {
    mode: "ssr",
    page: runtimePage(
      staticSpecificRoute.page({
        component: () => null,
        loader: () => ({ pageData: "from-static-specific" }),
      })
    ),
    path: "/dynamic/specific",
    pattern: "/dynamic/specific",
    routeChain: [runtimeRoute(rootRoute), runtimeRoute(staticSpecificRoute)],
    segmentBoundaries: [],
  },
  {
    mode: "ssr",
    page: runtimePage(
      accountRoute.page({
        component: () => null,
        loader: ({ redirect }) => {
          throw redirect("?tab=billing");
        },
      })
    ),
    path: "/account",
    pattern: "/account",
    routeChain: [runtimeRoute(rootRoute), runtimeRoute(accountRoute)],
    segmentBoundaries: [],
  },
  {
    mode: "ssr",
    page: runtimePage(
      dynamicDeferRoute.page({
        component: () => null,
        loader: ({ params }) =>
          defer({
            post: Promise.resolve({ title: `Post for ${String(params.slug)}` }),
            slug: String(params.slug),
          }),
      })
    ),
    path: "/dynamic-defer/[slug]",
    pattern: "/dynamic-defer/:slug",
    routeChain: [runtimeRoute(rootRoute), runtimeRoute(dynamicDeferRoute)],
    segmentBoundaries: [],
  },
];

function createDataTestApp(): { app: Elysia; routes: ResolvedRoute[] } {
  const routes = BASE_ROUTES.map(cloneResolvedRoute);
  return { app: new Elysia().use(createDataEndpoint(routes)), routes };
}

__setDevMode(false);

describe("GET /_furin/data", () => {
  test("returns 400 if the path parameter is missing", async () => {
    const app = new Elysia().use(createDataEndpoint([]));

    const res = await app.handle(new Request("http://localhost/_furin/data"));

    expect(res.status).toBe(400);
  });

  test("rejects an absolute URL passed in ?path= (open-redirect prevention)", async () => {
    const app = new Elysia().use(createDataEndpoint([]));

    // Without the prefix/origin guard, `new URL("https://evil.com/foo", base)`
    // ignores the base and the attacker-controlled origin would propagate to
    // `syntheticRequest.url`.
    const res = await app.handle(
      new Request("http://localhost/_furin/data?path=https%3A%2F%2Fevil.com%2Ffoo")
    );

    expect(res.status).toBe(400);
  });

  test("rejects a protocol-relative path `//host/foo`", async () => {
    const app = new Elysia().use(createDataEndpoint([]));

    const res = await app.handle(
      new Request("http://localhost/_furin/data?path=%2F%2Fevil.com%2Ffoo")
    );

    expect(res.status).toBe(400);
  });

  test("resolves query defaults without emitting a redirect sentinel", async () => {
    const { app } = createDataTestApp();

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

  test("resolves search-only redirects against the logical route URL", async () => {
    const { app } = createDataTestApp();

    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Faccount"));

    expect(res.status).toBe(200);

    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );

    expect(syncData.__furinRedirect).toBe("/account?tab=billing");
  });

  test("passes schema-coerced query values to loaders during SPA navigation", async () => {
    const { app } = createDataTestApp();

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
    const { app } = createDataTestApp();

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
    const { app } = createDataTestApp();

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
    const { app } = createDataTestApp();

    const res = await app.handle(
      new Request("http://localhost/_furin/data?path=%2Froute-inexistante")
    );

    expect(res.status).toBe(404);
  });

  test("returns NDJSON for a route with a synchronous loader", async () => {
    const { app, routes } = createDataTestApp();
    const withLoaderRoute = routes.find((r) => r.pattern === "/with-loader");
    if (!withLoaderRoute) {
      throw new Error("No /with-loader route in fixtures");
    }
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

  test("returns route frames with Promise for a route using defer()", async () => {
    const { app, routes } = createDataTestApp();
    const deferRoute = routes.find((r) => r.pattern === "/defer-page");
    if (!deferRoute) {
      throw new Error("No /defer-page route in fixtures — add defer-page.tsx");
    }
    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fdefer-page"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-furin-route");

    const { syncData, deferredPromises } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.title).toBe("deferred page");
    expect(deferredPromises.stats).toBeInstanceOf(Promise);
    const resolvedStats = await deferredPromises.stats;
    expect(resolvedStats).toBe(42);
  });

  test("streams requestData for an ISR route during SPA navigation", async () => {
    const routeDefinition = createRoute({
      loader: () => ({ catalog: "Shoes" }),
      mode: "isr",
      requestLoader: ({ cookies }) => ({ user: cookies.get("session") }),
    });
    const route = {
      mode: "isr",
      page: runtimePage(routeDefinition.page({ component: () => null })),
      path: "/ppr-account",
      pattern: "/ppr-account",
      routeChain: [runtimeRoute(routeDefinition)],
      segmentBoundaries: [],
    } satisfies ResolvedRoute;
    const app = new Elysia().use(createDataEndpoint([route]));

    const res = await app.handle(
      new Request("http://localhost/_furin/data?path=%2Fppr-account", {
        headers: { cookie: "session=alice" },
      })
    );

    expect(res.status).toBe(200);
    const { deferredPromises, syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.catalog).toBe("Shoes");
    expect(deferredPromises.requestData).toBeInstanceOf(Promise);
    expect(await deferredPromises.requestData).toEqual({ user: "alice" });
  });

  test("returns the response before deferred Promises have resolved", async () => {
    const { app, routes } = createDataTestApp();
    const deferRoute = routes.find((r) => r.pattern === "/defer-page");
    if (!deferRoute?.page) {
      throw new Error("No /defer-page route in fixtures — add defer-page.tsx");
    }
    let resolveStats: ((value: number) => void) | undefined;
    const stats = new Promise<number>((resolve) => {
      resolveStats = resolve;
    });

    // Replace `.page` with a shallow copy instead of mutating the shared
    // module export — `scanPages` returns routes whose `.page` is the cached
    // import, so in-place mutation would leak into other tests.
    deferRoute.page = {
      ...deferRoute.page,
      loader: () =>
        defer({
          stats,
          title: "deferred page",
        }),
    };
    const responsePromise = app.handle(
      new Request("http://localhost/_furin/data?path=%2Fdefer-page")
    );

    const res = await Promise.race([
      responsePromise,
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    if (res === "blocked") {
      resolveStats?.(42);
      throw new Error("Data endpoint waited for a deferred Promise before returning a Response.");
    }
    expect(res.status).toBe(200);

    if (resolveStats === undefined) {
      throw new Error("Deferred stats resolver was not initialized.");
    }
    resolveStats(42);
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
    const { app, routes } = createDataTestApp();
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
    const { app, routes } = createDataTestApp();
    const ssrRoute = routes.find((r) => r.pattern === "/ssr-page");
    if (!ssrRoute) {
      throw new Error("No /ssr-page route in fixtures");
    }
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
    const { app } = createDataTestApp();

    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fdynamic%2F42"));

    expect(res.status).toBe(200);
    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.params).toEqual({ id: "42" });
    expect(syncData.path).toBe("/dynamic/42");
  });

  test("passes schema-coerced params to loaders during SPA navigation", async () => {
    const { app } = createDataTestApp();

    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fnumber%2F42"));

    expect(res.status).toBe(200);
    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.params).toEqual({ id: 42 });
    expect(syncData.paramsFromLoader).toEqual({ id: 42 });
  });

  test("rejects invalid schema params before running loaders during SPA navigation", async () => {
    const { app, routes } = createDataTestApp();
    const route = routes.find((r) => r.pattern === "/number/:id");
    if (!route) {
      throw new Error("No /number/:id route in fixtures");
    }
    let loaderRuns = 0;
    route.page = {
      ...route.page,
      loader: () => {
        loaderRuns += 1;
        return { pageData: "should-not-run" };
      },
    };

    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fnumber%2Fnope"));

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      message: "Invalid params",
      type: "validation",
    });
    expect(loaderRuns).toBe(0);
  });

  test("prefers a static route over a dynamic sibling that also matches", async () => {
    // `/dynamic/specific` (static) and `/dynamic/:id` (dynamic) both match the
    // path `/dynamic/specific`. The endpoint must pick the static route — the
    // dynamic one would otherwise shadow it (its dir `[id]` is scanned first).
    const { app } = createDataTestApp();

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
    const { app, routes } = createDataTestApp();
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
          asyncWidget: Promise.resolve(["item-a", "item-b"]),
          layoutData: "from-layout-defer",
        }),
    };
    route.routeChain = route.routeChain.map((r) => (r === layoutEntry ? patched : r));
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

  test("layout defer + page defer → both deferred Promises arrive as separate route frames", async () => {
    const { app, routes } = createDataTestApp();
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
          asyncWidget: Promise.resolve("widget-ok"),
          layoutData: "from-layout",
        }),
    };
    route.routeChain = route.routeChain.map((r) => (r === layoutEntry ? patchedLayout : r));
    route.page = {
      ...route.page,
      loader: () =>
        defer({
          asyncStats: Promise.resolve(99),
          pageData: "from-page",
        }),
    };
    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fwith-loader"));

    expect(res.status).toBe(200);
    const text = await new Response(res.body).text();
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    // Line 0 is the initial sync payload. Subsequent lines are resolution frames
    // — one per deferred field, regardless of which loader produced it.
    const resolutionKeys = lines
      .slice(1)
      .map((line) => (JSON.parse(line) as { frame: { key: string } }).frame.key);
    expect(resolutionKeys.sort()).toEqual(["asyncStats", "asyncWidget"]);
  });

  test("emits chunks in resolution order, not insertion order", async () => {
    // 'slow' is inserted FIRST in defer() but resolves LAST. 'fast' is inserted
    // SECOND but resolves FIRST. The on-the-wire stream MUST emit the fast key
    // first — otherwise streaming is cosmetic and a fast field is held hostage
    // by a slow sibling. This is the whole reason defer() exists.
    const { app, routes } = createDataTestApp();
    const deferRoute = routes.find((r) => r.pattern === "/defer-page");
    if (!deferRoute?.page) {
      throw new Error("No /defer-page route in fixtures");
    }
    let resolveFast: ((value: string) => void) | undefined;
    let resolveSlow: ((value: string) => void) | undefined;
    const fast = new Promise<string>((resolve) => {
      resolveFast = resolve;
    });
    const slow = new Promise<string>((resolve) => {
      resolveSlow = resolve;
    });
    // Shallow-copy `.page` rather than mutating the shared module export.
    deferRoute.page = {
      ...deferRoute.page,
      loader: () =>
        defer({
          fast,
          slow,
          title: "deferred page",
        }),
    };
    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fdefer-page"));

    const textPromise = new Response(res.body).text();
    if (resolveFast === undefined || resolveSlow === undefined) {
      throw new Error("Deferred order resolvers were not initialized.");
    }
    resolveFast("fast-value");
    await Promise.resolve();
    resolveSlow("slow-value");
    const text = await textPromise;
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    // Line 0 is the initial sync payload, lines 1+ are resolution frames.
    const resolutionKeys = lines
      .slice(1)
      .map((line) => (JSON.parse(line) as { frame: { key: string } }).frame.key);

    expect(resolutionKeys).toEqual(["fast", "slow"]);
  });

  test("defer() on a dynamic route: params are in syncData and deferred Promises stream", async () => {
    const { app } = createDataTestApp();

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
    const { app, routes } = createDataTestApp();
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
    const { app, routes } = createDataTestApp();
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
