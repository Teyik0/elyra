// biome-ignore-all lint/suspicious/noTemplateCurlyInString: needed
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { t } from "elysia";
import { patternToTypeString, schemaToTypeString, writeRouteTypes } from "../src/build";
import type { ResolvedRoute } from "../src/server/router/index.ts";

// ── patternToTypeString ───────────────────────────────────────────────────────

describe("patternToTypeString", () => {
  test("static routes — wrapped in double quotes", () => {
    expect(patternToTypeString("/")).toBe('"/"');
    expect(patternToTypeString("/blog")).toBe('"/blog"');
    expect(patternToTypeString("/dashboard/settings")).toBe('"/dashboard/settings"');
  });

  test("single dynamic param — produces a template literal type string", () => {
    // The returned string literally contains backtick + ${string} — it's TS source code
    expect(patternToTypeString("/blog/:slug")).toBe("`/blog/${string}`");
    expect(patternToTypeString("/users/:id")).toBe("`/users/${string}`");
  });

  test("multiple dynamic params — all param segments replaced", () => {
    expect(patternToTypeString("/users/:userId/posts/:postId")).toBe(
      "`/users/${string}/posts/${string}`"
    );
  });

  test("wildcard catch-all (*) — produces a template literal type string", () => {
    expect(patternToTypeString("/*")).toBe("`/${string}`");
  });

  test("mixed static and dynamic segments", () => {
    expect(patternToTypeString("/api/v1/:resource/:id")).toBe("`/api/v1/${string}/${string}`");
  });
});

// ── schemaToTypeString ────────────────────────────────────────────────────────

describe("schemaToTypeString", () => {
  test("null/undefined schema — returns 'unknown'", () => {
    expect(schemaToTypeString(null)).toBe("unknown");
    expect(schemaToTypeString(undefined)).toBe("unknown");
  });

  test("string schema", () => {
    expect(schemaToTypeString({ type: "string" })).toBe("string");
  });

  test("number schema", () => {
    expect(schemaToTypeString({ type: "number" })).toBe("number");
    expect(schemaToTypeString({ type: "integer" })).toBe("number");
  });

  test("boolean schema", () => {
    expect(schemaToTypeString({ type: "boolean" })).toBe("boolean");
  });

  test("null schema", () => {
    expect(schemaToTypeString({ type: "null" })).toBe("null");
  });

  test("object schema — all required fields", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name", "age"],
    };
    expect(schemaToTypeString(schema)).toBe("{ name: string; age: number }");
  });

  test("object schema — all optional fields (not in required array)", () => {
    const schema = {
      type: "object",
      properties: { page: { type: "number" }, tag: { type: "string" } },
      required: [],
    };
    expect(schemaToTypeString(schema)).toBe("{ page?: number; tag?: string }");
  });

  test("object schema — optional field with default is present", () => {
    const schema = {
      type: "object",
      properties: { city: { type: "string", default: "Paris" }, tag: { type: "string" } },
      required: [],
    };
    expect(schemaToTypeString(schema)).toBe("{ city: string; tag?: string }");
  });

  test("object schema — mixed required and optional", () => {
    const schema = {
      type: "object",
      properties: { id: { type: "string" }, page: { type: "number" } },
      required: ["id"],
    };
    expect(schemaToTypeString(schema)).toBe("{ id: string; page?: number }");
  });

  test("object schema — no required array (all optional)", () => {
    const schema = {
      type: "object",
      properties: { q: { type: "string" } },
    };
    expect(schemaToTypeString(schema)).toBe("{ q?: string }");
  });

  test("object schema — no properties", () => {
    expect(schemaToTypeString({ type: "object" })).toBe("Record<string, unknown>");
  });

  test("anyOf — union without null", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "number" }] };
    expect(schemaToTypeString(schema)).toBe("string | number");
  });

  test("anyOf — null is filtered out (nullable types)", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "null" }] };
    expect(schemaToTypeString(schema)).toBe("string");
  });

  test("unknown type — returns 'unknown'", () => {
    expect(schemaToTypeString({ type: "exotic" })).toBe("unknown");
  });
});

// ── writeRouteTypes ───────────────────────────────────────────────────────────

describe("writeRouteTypes", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = join(import.meta.dir, "__tmp_route_types__");
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Build minimal ResolvedRoute stubs. */
  function routes(
    patterns: string[],
    querySchemas: Record<string, unknown> | undefined,
    tags: Record<string, string[]> | undefined
  ): ResolvedRoute[] {
    const resolvedQuerySchemas = querySchemas ?? {};
    const resolvedTags = tags ?? {};
    return patterns.map((pattern) => ({
      pattern,
      tags: resolvedTags[pattern],
      routeChain: resolvedQuerySchemas[pattern]
        ? [{ __type: "FURIN_ROUTE" as const, query: resolvedQuerySchemas[pattern] }]
        : [],
    })) as ResolvedRoute[];
  }

  test("creates furin-env.d.ts with the correct module declaration", () => {
    writeRouteTypes(routes(["/"], undefined, undefined), tmpDir);

    const content = readFileSync(join(tmpDir, "furin-env.d.ts"), "utf8");
    expect(content).toContain("Auto-generated by Furin");
    expect(content).toContain('import "@teyik0/furin/link"');
    expect(content).toContain('import "@teyik0/furin/search"');
    expect(content).toContain('declare module "@teyik0/furin/link"');
    expect(content).toContain('declare module "@teyik0/furin/search"');
    expect(content).toContain("interface RouteManifest");
  });

  test("static route without query — emits search?: never", () => {
    writeRouteTypes(routes(["/"], undefined, undefined), tmpDir);

    const content = readFileSync(join(tmpDir, "furin-env.d.ts"), "utf8");
    expect(content).toContain('"/": { search?: never }');
  });

  test("static route with query schema — emits typed search", () => {
    const querySchema = {
      type: "object",
      properties: { page: { type: "number" }, tag: { type: "string" } },
      required: [],
    };
    writeRouteTypes(routes(["/blog"], { "/blog": querySchema }, undefined), tmpDir);

    const content = readFileSync(join(tmpDir, "furin-env.d.ts"), "utf8");
    expect(content).toContain('"/blog": { search?: { page?: number; tag?: string } }');
  });

  test("route-chain query schemas are merged in generated search types", () => {
    const routes = [
      {
        pattern: "/parent/child",
        routeChain: [
          {
            __type: "FURIN_ROUTE" as const,
            query: t.Object({ parentFilter: t.Optional(t.String()) }),
          },
          {
            __type: "FURIN_ROUTE" as const,
            query: t.Object({ childFilter: t.Optional(t.String()) }),
          },
        ],
      },
    ] as ResolvedRoute[];

    writeRouteTypes(routes, tmpDir);

    const content = readFileSync(join(tmpDir, "furin-env.d.ts"), "utf8");
    expect(content).toContain(
      '"/parent/child": { search?: { parentFilter?: string; childFilter?: string } }'
    );
  });

  test("dynamic route — uses index signature syntax", () => {
    writeRouteTypes(routes(["/blog/:slug"], undefined, undefined), tmpDir);

    const content = readFileSync(join(tmpDir, "furin-env.d.ts"), "utf8");
    // The file literally contains: [key: `/blog/${string}`]: { search?: never }
    expect(content).toContain("[key: `/blog/${string}`]: { search?: never }");
  });

  test("mixed static and dynamic routes", () => {
    writeRouteTypes(routes(["/", "/blog", "/blog/:slug"], undefined, undefined), tmpDir);

    const content = readFileSync(join(tmpDir, "furin-env.d.ts"), "utf8");
    expect(content).toContain('"/": { search?: never }');
    expect(content).toContain('"/blog": { search?: never }');
    expect(content).toContain("[key: `/blog/${string}`]: { search?: never }");
  });

  test("idempotent — calling twice with the same routes produces identical output", () => {
    const path = join(tmpDir, "furin-env.d.ts");

    writeRouteTypes(routes(["/"], undefined, undefined), tmpDir);
    const first = readFileSync(path, "utf8");

    writeRouteTypes(routes(["/"], undefined, undefined), tmpDir);
    const second = readFileSync(path, "utf8");

    expect(first).toBe(second);
  });

  test("updates the file when routes change", () => {
    const path = join(tmpDir, "furin-env.d.ts");

    writeRouteTypes(routes(["/"], undefined, undefined), tmpDir);
    const before = readFileSync(path, "utf8");

    writeRouteTypes(routes(["/", "/blog"], undefined, undefined), tmpDir);
    const after = readFileSync(path, "utf8");

    expect(before).not.toBe(after);
    expect(after).toContain('"/blog"');
  });

  test("creates the file even if it did not exist before", () => {
    const freshDir = join(tmpDir, "fresh");
    mkdirSync(freshDir, { recursive: true });

    expect(existsSync(join(freshDir, "furin-env.d.ts"))).toBe(false);
    writeRouteTypes(routes(["/"], undefined, undefined), freshDir);
    expect(existsSync(join(freshDir, "furin-env.d.ts"))).toBe(true);
  });

  test("generates FurinCacheTags when routes have tags", () => {
    writeRouteTypes(
      routes(["/", "/blog"], {}, { "/": ["boards", "board"], "/blog": ["posts"] }),
      tmpDir
    );

    const content = readFileSync(join(tmpDir, "furin-env.d.ts"), "utf8");
    expect(content).toContain('declare module "@teyik0/furin"');
    expect(content).toContain("interface FurinCacheTags");
    expect(content).toContain("boards: 'boards';");
    expect(content).toContain("board: 'board';");
    expect(content).toContain("posts: 'posts';");
  });

  test("omits FurinCacheTags section when no routes have tags", () => {
    writeRouteTypes(routes(["/"], {}, {}), tmpDir);

    const content = readFileSync(join(tmpDir, "furin-env.d.ts"), "utf8");
    expect(content).not.toContain("FurinCacheTags");
  });

  test("tags are sorted alphabetically and deduplicated", () => {
    writeRouteTypes(
      routes(["/", "/blog"], {}, { "/": ["zzz", "aaa", "aaa"], "/blog": ["bbb"] }),
      tmpDir
    );

    const content = readFileSync(join(tmpDir, "furin-env.d.ts"), "utf8");
    const aaaIdx = content.indexOf("aaa: 'aaa'");
    const bbbIdx = content.indexOf("bbb: 'bbb'");
    const zzzIdx = content.indexOf("zzz: 'zzz'");

    expect(aaaIdx).toBeGreaterThanOrEqual(0);
    expect(aaaIdx).toBeLessThan(bbbIdx);
    expect(bbbIdx).toBeLessThan(zzzIdx);

    // Verify deduplication: "aaa" must appear exactly once.
    const aaaOccurrences = content.split("aaa: 'aaa'").length - 1;
    expect(aaaOccurrences).toBe(1);
  });
});
