/**
 * Regression tests — schema merging in createRoutePlugin (router.ts).
 *
 * Fix: mergeRouteSchemas() merges all TObject.properties across the routeChain
 * into a single t.Object so every ancestor's fields are present in the Elysia guard.
 *
 * Fixture: pages/schema-merge-parent/child/index.tsx
 *   routeChain = [rootRoute, parentRoute (parentFilter default), childRoute (childFilter default)]
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

mock.module("evlog/elysia", () => ({
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
  useLogger: () => ({ set() {} }),
  evlog: () => (app: unknown) => app,
}));

import { Elysia, t } from "elysia";
import type { RuntimeRoute } from "furin";
import {
  collectRouteTags,
  createDataEndpoint,
  createRoutePlugin,
  scanPages,
} from "furin/server/router";
import { __setDevMode, IS_DEV } from "furin/server/runtime-env";
import { array, object, optional, string } from "valibot";
import { z } from "zod";
import { parseRouteQuery } from "../../src/server/router/schemas.ts";

const FIXTURES_DIR = join(import.meta.dirname, "../fixtures/pages");
const ROUTE_PATTERN = "/schema-merge-parent/child";

let originalDevMode: boolean;
beforeAll(() => {
  originalDevMode = IS_DEV;
  __setDevMode(false);
});
afterAll(() => __setDevMode(originalDevMode));

describe("parseRouteQuery", () => {
  test("matches Elysia query parsing when no query schema exists", async () => {
    const app = new Elysia().get("/products", ({ query }) => Response.json(query));
    const response = await app.handle(
      new Request("http://localhost/products?tag=react&tag=furin&active=true")
    );
    const elysiaQuery = await response.json();

    const result = await parseRouteQuery(
      new URL("http://localhost/products?tag=react&tag=furin&active=true"),
      undefined
    );

    expect(result).toEqual({ ok: true, query: elysiaQuery });
  });

  test("coerces anyOf array and object query schemas", async () => {
    const schema = t.Object({
      filter: t.Union([t.Object({ category: t.String() }), t.Null()]),
      tags: t.Union([t.Array(t.String()), t.Null()]),
    });

    const result = await parseRouteQuery(
      new URL('http://localhost/products?tags=react&tags=furin&filter={"category":"framework"}'),
      schema
    );

    expect(result).toEqual({
      ok: true,
      query: {
        filter: { category: "framework" },
        tags: ["react", "furin"],
      },
    });
  });

  test("validates Zod schema with defaults", async () => {
    const schema = z.object({ page: z.string().default("1") });

    const result = await parseRouteQuery(new URL("http://localhost/products"), schema as any);

    expect(result).toEqual({
      ok: true,
      query: { page: "1" },
    });
  });

  test("validates Zod schema with arrays", async () => {
    const schema = z.object({ tags: z.array(z.string()) });

    const result = await parseRouteQuery(
      new URL("http://localhost/products?tags=a&tags=b"),
      schema as any
    );

    expect(result).toEqual({
      ok: true,
      query: { tags: ["a", "b"] },
    });
  });

  test("validates Valibot schema with defaults", async () => {
    const schema = object({ page: optional(string(), "1") });

    const result = await parseRouteQuery(new URL("http://localhost/products"), schema as any);

    expect(result).toEqual({
      ok: true,
      query: { page: "1" },
    });
  });

  test("validates Valibot schema with arrays", async () => {
    const schema = object({ tags: array(string()) });

    const result = await parseRouteQuery(
      new URL("http://localhost/products?tags=a&tags=b"),
      schema as any
    );

    expect(result).toEqual({
      ok: true,
      query: { tags: ["a", "b"] },
    });
  });
});

describe("createDataEndpoint — standard schemas", () => {
  test("validates Zod query schemas per routeNode and returns 200", async () => {
    const routes = [
      {
        pattern: "/products",
        mode: "ssr" as const,
        path: "pages/products/index.tsx",
        routeChain: [
          {
            __type: "FURIN_ROUTE" as const,
            query: z.object({ search: z.string() }),
          } as RuntimeRoute,
        ],
        page: {
          __type: "FURIN_PAGE" as const,
          _route: { __type: "FURIN_ROUTE" as const },
          component: () => null,
        },
        segmentBoundaries: [],
      },
    ];

    const app = new Elysia().use(createDataEndpoint(routes as any));

    const resOk = await app.handle(
      new Request("http://localhost/_furin/data?path=/products?search=hello")
    );
    expect(resOk.status).toBe(200);

    const resErr = await app.handle(new Request("http://localhost/_furin/data?path=/products"));
    expect(resErr.status).toBe(422);
  });

  test("validates chained Zod query schemas across route chain", async () => {
    const routes = [
      {
        pattern: "/products",
        mode: "ssr" as const,
        path: "pages/products/index.tsx",
        routeChain: [
          {
            __type: "FURIN_ROUTE" as const,
            query: z.object({ parent: z.string() }),
          } as RuntimeRoute,
          {
            __type: "FURIN_ROUTE" as const,
            query: z.object({ child: z.string() }),
          } as RuntimeRoute,
        ],
        page: {
          __type: "FURIN_PAGE" as const,
          _route: { __type: "FURIN_ROUTE" as const },
          component: () => null,
        },
        segmentBoundaries: [],
      },
    ];

    const app = new Elysia().use(createDataEndpoint(routes as any));

    const resOk = await app.handle(
      new Request(
        `http://localhost/_furin/data?path=${encodeURIComponent("/products?parent=a&child=b")}`
      )
    );
    expect(resOk.status).toBe(200);

    const resErr = await app.handle(
      new Request(`http://localhost/_furin/data?path=${encodeURIComponent("/products?parent=a")}`)
    );
    expect(resErr.status).toBe(422);
  });

  test("validates Valibot query schemas per routeNode and returns 200", async () => {
    const routes = [
      {
        pattern: "/products",
        mode: "ssr" as const,
        path: "pages/products/index.tsx",
        routeChain: [
          {
            __type: "FURIN_ROUTE" as const,
            query: object({ search: string() }),
          } as RuntimeRoute,
        ],
        page: {
          __type: "FURIN_PAGE" as const,
          _route: { __type: "FURIN_ROUTE" as const },
          component: () => null,
        },
        segmentBoundaries: [],
      },
    ];

    const app = new Elysia().use(createDataEndpoint(routes as any));

    const resOk = await app.handle(
      new Request(
        `http://localhost/_furin/data?path=${encodeURIComponent("/products?search=hello")}`
      )
    );
    expect(resOk.status).toBe(200);

    const resErr = await app.handle(
      new Request(`http://localhost/_furin/data?path=${encodeURIComponent("/products")}`)
    );
    expect(resErr.status).toBe(422);
  });

  test("validates route params against matched params, not query string", async () => {
    const routes = [
      {
        pattern: "/products/:id",
        mode: "ssr" as const,
        path: "pages/products/[id].tsx",
        routeChain: [
          {
            __type: "FURIN_ROUTE" as const,
            params: t.Object({ id: t.String() }),
          } as RuntimeRoute,
        ],
        page: {
          __type: "FURIN_PAGE" as const,
          _route: { __type: "FURIN_ROUTE" as const },
          component: () => null,
        },
        segmentBoundaries: [],
      },
    ];

    const app = new Elysia().use(createDataEndpoint(routes as any));

    const resOk = await app.handle(
      new Request(
        `http://localhost/_furin/data?path=${encodeURIComponent("/products/123?search=hello")}`
      )
    );
    expect(resOk.status).toBe(200);
  });
});

describe("collectRouteTags", () => {
  test("deduplicates route-chain and page-level tags", () => {
    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", tags: ["root", "shared"] },
      { __type: "FURIN_ROUTE", tags: ["board", "shared"] },
    ];
    const page = {
      __type: "FURIN_PAGE" as const,
      _route: chain[1] as RuntimeRoute,
      component: () => null,
      tags: ["cards", "board"],
    };

    expect(collectRouteTags(chain, page)).toEqual(["root", "shared", "board", "cards"]);
  });

  test("returns undefined when no route or page tags exist", () => {
    const chain: RuntimeRoute[] = [{ __type: "FURIN_ROUTE" }];

    expect(collectRouteTags(chain, undefined)).toBeUndefined();
  });
});

// ── Integration: HTTP requests resolve defaults from all ancestors ────────────

describe("schema merge — parent + child both declare query schemas", () => {
  test("routeChain contains query schemas from both parent and child _route.tsx", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const route = result.routes.find((r) => r.pattern === ROUTE_PATTERN);

    if (!route) {
      throw new Error(`Route ${ROUTE_PATTERN} not found — did the fixture files get created?`);
    }

    const chainEntries = route.routeChain.filter((r) => r.query);
    expect(chainEntries.length).toBe(2);
  });

  test("query defaults from all ancestors resolve without redirecting", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const route = result.routes.find((r) => r.pattern === ROUTE_PATTERN);

    if (!route) {
      throw new Error(`Route ${ROUTE_PATTERN} not found — did the fixture files get created?`);
    }

    const app = new Elysia().use(createRoutePlugin({ route, root: result.root, buildId: null }));

    const res = await app.handle(new Request(`http://localhost${ROUTE_PATTERN}`));

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  test("keeps serving when all merged defaults are already in the URL", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const route = result.routes.find((r) => r.pattern === ROUTE_PATTERN);

    if (!route) {
      throw new Error(`Route ${ROUTE_PATTERN} not found`);
    }

    const app = new Elysia().use(createRoutePlugin({ route, root: result.root, buildId: null }));

    const res = await app.handle(
      new Request(
        `http://localhost${ROUTE_PATTERN}?parentFilter=parent-default&childFilter=child-default`
      )
    );

    expect(res.status).toBe(200);
  });
});

// ── Tracer bullet: Standard Schema support ─────────────────────────────────────

describe("standard schema — Zod", () => {
  test("createRoutePlugin accepts a single Zod schema and validates query params", async () => {
    const route = {
      pattern: "/products",
      mode: "ssr" as const,
      path: "pages/products/index.tsx",
      routeChain: [
        {
          __type: "FURIN_ROUTE" as const,
          query: z.object({ search: z.string() }),
        } as RuntimeRoute,
      ],
      page: {
        __type: "FURIN_PAGE" as const,
        _route: { __type: "FURIN_ROUTE" as const },
        component: () => null,
      },
      segmentBoundaries: [],
    };

    const app = new Elysia().use(
      createRoutePlugin({
        route: route as any,
        root: { route: { __type: "FURIN_ROUTE" } as any } as any,
        buildId: null,
      })
    );

    // Valid query
    const resOk = await app.handle(new Request("http://localhost/products?search=hello"));
    expect(resOk.status).toBe(200);

    // Invalid query (missing required param)
    const resErr = await app.handle(new Request("http://localhost/products"));
    expect(resErr.status).toBe(422);
  });

  test("createRoutePlugin chains Zod schemas across route chain — both query keys present", async () => {
    const route = {
      pattern: "/products",
      mode: "ssr" as const,
      path: "pages/products/index.tsx",
      routeChain: [
        {
          __type: "FURIN_ROUTE" as const,
          query: z.object({ parent: z.string() }),
        } as RuntimeRoute,
        {
          __type: "FURIN_ROUTE" as const,
          query: z.object({ child: z.string() }),
        } as RuntimeRoute,
      ],
      page: {
        __type: "FURIN_PAGE" as const,
        _route: { __type: "FURIN_ROUTE" as const },
        component: () => null,
      },
      segmentBoundaries: [],
    };

    const app = new Elysia().use(
      createRoutePlugin({
        route: route as any,
        root: { route: { __type: "FURIN_ROUTE" } as any } as any,
        buildId: null,
      })
    );

    // Valid query — both keys present
    const resOk = await app.handle(new Request("http://localhost/products?parent=a&child=b"));
    expect(resOk.status).toBe(200);

    // Invalid query — missing child
    const resErr = await app.handle(new Request("http://localhost/products?parent=a"));
    expect(resErr.status).toBe(422);
  });
});

describe("standard schema — Valibot", () => {
  test("createRoutePlugin accepts a single Valibot schema and validates query params", async () => {
    const route = {
      pattern: "/products",
      mode: "ssr" as const,
      path: "pages/products/index.tsx",
      routeChain: [
        {
          __type: "FURIN_ROUTE" as const,
          query: object({ search: string() }),
        } as RuntimeRoute,
      ],
      page: {
        __type: "FURIN_PAGE" as const,
        _route: { __type: "FURIN_ROUTE" as const },
        component: () => null,
      },
      segmentBoundaries: [],
    };

    const app = new Elysia().use(
      createRoutePlugin({
        route: route as any,
        root: { route: { __type: "FURIN_ROUTE" } as any } as any,
        buildId: null,
      })
    );

    // Valid query
    const resOk = await app.handle(new Request("http://localhost/products?search=hello"));
    expect(resOk.status).toBe(200);

    // Invalid query (missing required param)
    const resErr = await app.handle(new Request("http://localhost/products"));
    expect(resErr.status).toBe(422);
  });

  test("createRoutePlugin chains Valibot schemas across route chain — both query keys present", async () => {
    const route = {
      pattern: "/products",
      mode: "ssr" as const,
      path: "pages/products/index.tsx",
      routeChain: [
        {
          __type: "FURIN_ROUTE" as const,
          query: object({ parent: string() }),
        } as RuntimeRoute,
        {
          __type: "FURIN_ROUTE" as const,
          query: object({ child: string() }),
        } as RuntimeRoute,
      ],
      page: {
        __type: "FURIN_PAGE" as const,
        _route: { __type: "FURIN_ROUTE" as const },
        component: () => null,
      },
      segmentBoundaries: [],
    };

    const app = new Elysia().use(
      createRoutePlugin({
        route: route as any,
        root: { route: { __type: "FURIN_ROUTE" } as any } as any,
        buildId: null,
      })
    );

    // Valid query — both keys present
    const resOk = await app.handle(new Request("http://localhost/products?parent=a&child=b"));
    expect(resOk.status).toBe(200);

    // Invalid query — missing child
    const resErr = await app.handle(new Request("http://localhost/products?parent=a"));
    expect(resErr.status).toBe(422);
  });
});
