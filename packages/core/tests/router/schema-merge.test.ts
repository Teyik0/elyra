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

import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { Elysia, t } from "elysia";
import type { RuntimeRoute } from "furin";
import {
  collectRouteSchemaSources,
  collectRouteTags,
  createRoutePlugin,
  mergeRouteSchemas,
  scanPages,
} from "furin/server/router";
import { __setDevMode, IS_DEV } from "furin/server/runtime-env";
import { number as vNumber, object as vObject, optional as vOptional } from "valibot";
import { number as zNumber, object as zObject, string as zString } from "zod";

const FIXTURES_DIR = join(import.meta.dirname, "../fixtures/pages");
const ROUTE_PATTERN = "/schema-merge-parent/child";

let originalDevMode: boolean;
beforeAll(() => {
  originalDevMode = IS_DEV;
  __setDevMode(false);
});
afterAll(() => __setDevMode(originalDevMode));

// ── mergeRouteSchemas unit tests ─────────────────────────────────────────────

describe("mergeRouteSchemas", () => {
  test("returns undefined when no entry in chain has the key", () => {
    const chain: RuntimeRoute[] = [{ __type: "FURIN_ROUTE" }, { __type: "FURIN_ROUTE" }];
    expect(mergeRouteSchemas(chain, "query")).toBeUndefined();
    expect(mergeRouteSchemas(chain, "params")).toBeUndefined();
  });

  test("returns the schema directly when only one entry has it", () => {
    const schema = t.Object({ city: t.Optional(t.String()) });
    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE" },
      { __type: "FURIN_ROUTE", query: schema },
    ];
    expect(mergeRouteSchemas(chain, "query")).toBe(schema);
  });

  test("merges properties from multiple entries — both keys present in result", () => {
    const parent = t.Object({ parentField: t.Optional(t.String()) });
    const child = t.Object({ childField: t.Optional(t.String()) });
    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE" },
      { __type: "FURIN_ROUTE", query: parent },
      { __type: "FURIN_ROUTE", query: child },
    ];

    const merged = mergeRouteSchemas(chain, "query") as ReturnType<typeof t.Object>;

    expect(merged).toBeDefined();
    expect(merged.properties).toHaveProperty("parentField");
    expect(merged.properties).toHaveProperty("childField");
  });

  test("leaf schema wins on key conflict", () => {
    const parentVal = t.String({ default: "parent" });
    const childVal = t.String({ default: "child" });
    const parent = t.Object({ shared: t.Optional(parentVal) });
    const child = t.Object({ shared: t.Optional(childVal) });
    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", query: parent },
      { __type: "FURIN_ROUTE", query: child },
    ];

    const merged = mergeRouteSchemas(chain, "query") as ReturnType<typeof t.Object>;

    // child is last → its Optional(childVal) wins
    const sharedSchema = merged.properties.shared as { [key: string]: unknown };
    expect(JSON.stringify(sharedSchema)).toContain('"child"');
  });

  // ── Cross-validator merging ────────────────────────────────────────────────

  test("merges TypeBox + Zod — properties from both schemas", () => {
    const parent = t.Object({ sort: t.Optional(t.String()) });
    const child = zObject({ page: zNumber().default(1) });
    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", query: parent },
      { __type: "FURIN_ROUTE", query: child },
    ];

    const merged = mergeRouteSchemas(chain, "query") as ReturnType<typeof t.Object>;

    expect(merged).toBeDefined();
    expect(merged.properties).toHaveProperty("sort");
    expect(merged.properties).toHaveProperty("page");
  });

  test("merges TypeBox + Valibot — properties from both schemas", () => {
    const parent = t.Object({ sort: t.Optional(t.String()) });
    const child = toStandardJsonSchema(vObject({ page: vOptional(vNumber(), 1) }));
    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", query: parent },
      { __type: "FURIN_ROUTE", query: child },
    ];

    const merged = mergeRouteSchemas(chain, "query") as ReturnType<typeof t.Object>;

    expect(merged).toBeDefined();
    expect(merged.properties).toHaveProperty("sort");
    expect(merged.properties).toHaveProperty("page");
  });

  test("merges Zod + Zod — leaf wins on key conflict", () => {
    const parent = zObject({ shared: zString().default("parent") });
    const child = zObject({ shared: zString().default("child") });
    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", query: parent },
      { __type: "FURIN_ROUTE", query: child },
    ];

    const merged = mergeRouteSchemas(chain, "query") as ReturnType<typeof t.Object>;
    const sharedSchema = merged.properties.shared as { [key: string]: unknown };
    expect(JSON.stringify(sharedSchema)).toContain('"child"');
  });

  test("throws clear error when a non-convertible schema is passed", () => {
    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", query: { plain: "object" } as unknown },
    ];

    expect(() => mergeRouteSchemas(chain, "query")).toThrow("Unsupported query schema");
  });

  test("throws clear error when a converted schema is not an object", () => {
    const chain: RuntimeRoute[] = [{ __type: "FURIN_ROUTE", query: zString() }];

    expect(() => mergeRouteSchemas(chain, "query")).toThrow("query schemas must be objects");
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

// ── Integration: HTTP redirect applies defaults from all ancestors ────────────

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

  test("query default redirect applies defaults from ALL ancestors, not just the leaf", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const route = result.routes.find((r) => r.pattern === ROUTE_PATTERN);

    if (!route) {
      throw new Error(`Route ${ROUTE_PATTERN} not found — did the fixture files get created?`);
    }

    const app = new Elysia().use(createRoutePlugin(route, result.root));

    // No query params → merged guard fills both defaults
    // → queryDefaultRedirectHook detects applied defaults → 302 to canonical URL
    const res = await app.handle(new Request(`http://localhost${ROUTE_PATTERN}`));

    expect(res.status).toBe(302);

    const location = res.headers.get("location") ?? "";
    expect(location).toContain("childFilter=child-default");
    expect(location).toContain("parentFilter=parent-default");
  });

  test("no redirect when all merged defaults are already in the URL", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const route = result.routes.find((r) => r.pattern === ROUTE_PATTERN);

    if (!route) {
      throw new Error(`Route ${ROUTE_PATTERN} not found`);
    }

    const app = new Elysia().use(createRoutePlugin(route, result.root));

    const res = await app.handle(
      new Request(
        `http://localhost${ROUTE_PATTERN}?parentFilter=parent-default&childFilter=child-default`
      )
    );

    expect(res.status).toBe(200);
  });
});

// ── Integration: cross-validator query defaults ──────────────────────────────

describe("cross-validator schema merge — TypeBox + Zod defaults", () => {
  test("merged guard fills defaults from both TypeBox and Zod", async () => {
    const parentRoute = {
      __type: "FURIN_ROUTE" as const,
      query: t.Object({ parentFilter: t.Optional(t.String({ default: "parent-default" })) }),
    };
    const childRoute = {
      __type: "FURIN_ROUTE" as const,
      query: zObject({ childFilter: zString().default("child-default") }),
      parent: parentRoute,
    };
    const page = { __type: "FURIN_PAGE" as const, _route: childRoute, component: () => null };

    const route = {
      pattern: "/cross-validator",
      page,
      path: "/cross-validator.tsx",
      routeChain: [parentRoute, childRoute],
      mode: "ssr" as const,
      segmentBoundaries: [],
    };

    const root = {
      path: "root.tsx",
      route: { __type: "FURIN_ROUTE" as const, layout: () => null },
    };
    const app = new Elysia().use(createRoutePlugin(route, root));

    const res = await app.handle(new Request("http://localhost/cross-validator"));

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("childFilter=child-default");
    expect(location).toContain("parentFilter=parent-default");
  });

  test("no redirect when all cross-validator defaults are already in the URL", async () => {
    const parentRoute = {
      __type: "FURIN_ROUTE" as const,
      query: t.Object({ parentFilter: t.Optional(t.String({ default: "parent-default" })) }),
    };
    const childRoute = {
      __type: "FURIN_ROUTE" as const,
      query: zObject({ childFilter: zString().default("child-default") }),
      parent: parentRoute,
    };
    const page = { __type: "FURIN_PAGE" as const, _route: childRoute, component: () => null };

    const route = {
      pattern: "/cross-validator",
      page,
      path: "/cross-validator.tsx",
      routeChain: [parentRoute, childRoute],
      mode: "ssr" as const,
      segmentBoundaries: [],
    };

    const root = {
      path: "root.tsx",
      route: { __type: "FURIN_ROUTE" as const, layout: () => null },
    };
    const app = new Elysia().use(createRoutePlugin(route, root));

    const res = await app.handle(
      new Request(
        "http://localhost/cross-validator?parentFilter=parent-default&childFilter=child-default"
      )
    );

    expect(res.status).toBe(200);
  });

  test("page-level query participates in runtime guard defaults", async () => {
    const parentRoute = {
      __type: "FURIN_ROUTE" as const,
      query: t.Object({ parentFilter: t.Optional(t.String({ default: "parent-default" })) }),
    };
    const childRoute = {
      __type: "FURIN_ROUTE" as const,
      parent: parentRoute,
    };
    const page = {
      __type: "FURIN_PAGE" as const,
      _route: childRoute,
      query: zObject({ pageFilter: zString().default("page-default") }),
      component: () => null,
    };

    const route = {
      pattern: "/page-query",
      page,
      path: "/page-query.tsx",
      routeChain: [parentRoute, childRoute],
      mode: "ssr" as const,
      segmentBoundaries: [],
    };

    expect(collectRouteSchemaSources(route)).toHaveLength(3);

    const root = {
      path: "root.tsx",
      route: { __type: "FURIN_ROUTE" as const, layout: () => null },
    };
    const app = new Elysia().use(createRoutePlugin(route, root));

    const res = await app.handle(new Request("http://localhost/page-query"));

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("pageFilter=page-default");
    expect(location).toContain("parentFilter=parent-default");
  });
});
