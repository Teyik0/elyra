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
  createRoutePlugin,
  mergeRouteSchemas,
  scanPages,
} from "furin/server/router";
import { __setDevMode, IS_DEV } from "furin/server/runtime-env";
import { parseRouteQuery } from "../../src/server/router/schemas.ts";

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

  test("returns a single non-TypeBox schema unchanged", () => {
    const schema = { "~standard": {} };
    const chain = [{ __type: "FURIN_ROUTE" as const, query: schema }];

    expect(mergeRouteSchemas(chain as RuntimeRoute[], "query")).toBe(schema);
  });

  test("throws a clear error when multi-route query merge is not TypeBox", () => {
    const parent = t.Object({ parentField: t.Optional(t.String()) });
    const child = { "~standard": {} };
    const chain = [
      { __type: "FURIN_ROUTE" as const, query: parent },
      { __type: "FURIN_ROUTE" as const, query: child },
    ];

    expect(() => mergeRouteSchemas(chain as RuntimeRoute[], "query")).toThrow(
      "[furin] Merging query schemas across the route chain requires TypeBox in V1. Use TypeBox for parent/child query, or define query only on leaf routes."
    );
  });

  test("throws when multi-route schemas include a plain JSON Schema object", () => {
    const parent = t.Object({ parentField: t.Optional(t.String()) });
    const child = {
      type: "object",
      properties: { childField: { type: "string" } },
      required: ["childField"],
    };
    const chain = [
      { __type: "FURIN_ROUTE" as const, query: parent },
      { __type: "FURIN_ROUTE" as const, query: child },
    ];

    expect(() => mergeRouteSchemas(chain as RuntimeRoute[], "query")).toThrow(
      "[furin] Merging query schemas across the route chain requires TypeBox in V1. Use TypeBox for parent/child query, or define query only on leaf routes."
    );
  });
});

describe("parseRouteQuery", () => {
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

    const app = new Elysia().use(createRoutePlugin(route, result.root));

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

    const app = new Elysia().use(createRoutePlugin(route, result.root));

    const res = await app.handle(
      new Request(
        `http://localhost${ROUTE_PATTERN}?parentFilter=parent-default&childFilter=child-default`
      )
    );

    expect(res.status).toBe(200);
  });
});
