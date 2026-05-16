/**
 * Unit tests for generateHydrateEntry basePath behaviour.
 *
 * These are pure-function tests — no React, no DOM, no file I/O.
 * The function just returns a string, so assertions are simple
 * substring checks on the generated source code.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateHydrateEntry } from "../src/build/hydrate.ts";
import type { ResolvedRoute } from "../src/router.ts";

// ── Minimal stub ──────────────────────────────────────────────────────────────

function makeRoute(pattern: string, filePath: string): ResolvedRoute {
  return {
    pattern,
    path: filePath,
    mode: "ssg",
    page: {
      component: () => null,
      _route: { __type: "FURIN_ROUTE" },
    },
  } as unknown as ResolvedRoute;
}

const ROUTES = [makeRoute("/", "/app/src/pages/index.tsx")];
const ROOT = "/app/src/pages/root.tsx";

// Biome's useTopLevelRegex: hoist Slice 10 regexes so repeated test runs
// don't reconstruct them inside the callback.
const INITIAL_DIGEST_BOUND_RE = /initialDigest:\s*loaderData\.__furinError\?\.digest/;
const LOADER_DIGEST_CHAIN_RE = /loaderData\.__furinError\?\.digest/;
const INITIAL_DIGEST_PROP_RE = /initialDigest:/;

// ── B12: no basePath — generated code is unchanged ───────────────────────────

describe("generateHydrateEntry", () => {
  test("imports RouterProvider via package specifier so client links share one RouterContext", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "");
    expect(code).toContain('import { RouterProvider } from "@teyik0/furin/link";');
    expect(code).not.toContain("/packages/core/src/link.tsx");
  });

  test("B12: without basePath — uses window.location.pathname directly", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "");
    // No basePath stripping logic
    expect(code).toContain("window.location.pathname");
    expect(code).not.toContain("startsWith");
    expect(code).not.toContain(".slice(");
  });

  test("B12b: without basePath — log drain endpoint is the bare path", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "");
    // endpoint should be the bare string, not a concatenation
    expect(code).toContain('endpoint: "/_furin/ingest"');
    // No string concatenation for the endpoint
    expect(code).not.toContain('" + "/_furin/ingest"');
  });

  test("B12c: without basePath — RouterProvider has basePath: ''", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "");
    expect(code).toContain('basePath: ""');
  });

  // ── B13: with basePath — stripping logic injected ────────────────────────────

  test("B13: with basePath='/furin' — code strips prefix before route matching", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "/furin");
    // The generated pathname expression uses a `b` variable for the basePath literal
    expect(code).toContain('const b = "/furin"');
    expect(code).toContain("startsWith(b)");
    expect(code).toContain("p.slice(b.length)");
  });

  test("B13b: with basePath — falls back to '/' when pathname equals basePath exactly", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "/furin");
    // e.g. "window.location.pathname.slice(...) || '/'"
    expect(code).toContain('|| "/"');
  });

  test("B13c: strips trailing slash from pathname before route matching", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "/furin");
    // The generated pathname expression must strip trailing slashes so that
    // "/furin/docs/routing/" → "/docs/routing" and matches the regex.
    expect(code).toContain(".replace(/\\/+$/");
  });

  test("B13d: without basePath — strips trailing slash from window.location.pathname", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "");
    expect(code).toContain("window.location.pathname.replace(/\\/+$/");
  });

  test("B13c: with basePath — log drain endpoint is prefixed", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "/furin");
    // endpoint should be basePath + "/_furin/ingest"
    expect(code).toContain('"/furin"');
    expect(code).toContain('"/_furin/ingest"');
  });

  // ── B14: basePath passed to RouterProvider ────────────────────────────────────

  test("B14: with basePath — RouterProvider receives basePath prop", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "/furin");
    expect(code).toContain('basePath: "/furin"');
  });

  test("B14b: different basePath value is correctly injected", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "/my-app");
    expect(code).toContain('basePath: "/my-app"');
    expect(code).toContain('const b = "/my-app"');
    expect(code).toContain("startsWith(b)");
  });

  test("client bundle keeps a single RouterContext when a page imports Link", () => {
    const tmpRoot = mkdtempSync(join(import.meta.dir, ".tmp-hydrate-entry-"));
    const outDir = join(tmpRoot, "out");
    mkdirSync(outDir, { recursive: true });

    try {
      const rootPath = join(tmpRoot, "root.tsx");
      const pagePath = join(tmpRoot, "index.tsx");
      const hydratePath = join(tmpRoot, "_hydrate.tsx");

      writeFileSync(
        rootPath,
        [
          'import { createRoute } from "@teyik0/furin/client";',
          "",
          "export const route = createRoute({",
          "  layout: ({ children }) => <div>{children}</div>,",
          "});",
        ].join("\n")
      );

      writeFileSync(
        pagePath,
        [
          'import { Link } from "@teyik0/furin/link";',
          "",
          "export default {",
          '  component: () => <Link to="/docs">Docs</Link>,',
          '  _route: { __type: "FURIN_ROUTE" },',
          "};",
        ].join("\n")
      );

      writeFileSync(hydratePath, generateHydrateEntry([makeRoute("/", pagePath)], rootPath, ""));

      const result = Bun.spawnSync(
        [
          "bun",
          "build",
          hydratePath,
          "--outdir",
          outDir,
          "--splitting",
          "--format",
          "esm",
          "--target",
          "browser",
        ],
        {
          cwd: join(import.meta.dir, "../.."),
          stderr: "pipe",
          stdout: "pipe",
        }
      );

      expect(result.exitCode).toBe(0);

      const chunks: string[] = [];
      for (const file of readdirSync(outDir)) {
        if (file.endsWith(".js")) {
          chunks.push(readFileSync(join(outDir, file), "utf8"));
        }
      }
      const bundleText = chunks.join("\n");

      expect((bundleText.match(/createContext\(null\)/g) ?? []).length).toBe(1);
    } finally {
      rmSync(tmpRoot, { force: true, recursive: true });
    }
  });
});

// ── Boundary chain emission (Slice 6) ─────────────────────────────────────────
//
// The client must render the same interleaved React tree as the server.
// To do that, each route entry carries a `segmentBoundaries` array of
// { depth, error?, notFound? } triples. The emitted code:
//   1. Emits ONE static `import` per unique convention file (across all routes).
//   2. References those identifiers inside each route's `segmentBoundaries`.
//   3. Skips the field entirely when a route has no boundaries, so existing
//      tests asserting "no basePath / no boundaries" still pass.

/** Builds a ResolvedRoute with a populated `segmentBoundaries` list. */
function makeRouteWithBoundaries(
  pattern: string,
  filePath: string,
  boundaries: Array<{
    depth: number;
    errorPath?: string;
    notFoundPath?: string;
  }>
): ResolvedRoute {
  return {
    ...makeRoute(pattern, filePath),
    // Component identity doesn't matter here — only the paths are used for
    // hydrate emission. The tests synthesize marker objects.
    segmentBoundaries: boundaries.map((b) => ({
      depth: b.depth,
      path: "/unused",
      // Marker components — `generateHydrateEntry` only reads the `*Path`
      // fields, so the identity of these functions doesn't matter.
      error: b.errorPath ? () => null : undefined,
      notFound: b.notFoundPath ? () => null : undefined,
      errorPath: b.errorPath,
      notFoundPath: b.notFoundPath,
    })),
  } as ResolvedRoute;
}

// Hoisted regex literals — Biome's `useTopLevelRegex` rule requires them out
// of the hot path; declaring them at module scope also makes the intent (what
// the hydrate output is expected to look like) clearer.
const ERROR_IMPORT_RE = /import __furin_bnd_\d+ from "\/app\/src\/pages\/error\.tsx";/;
const ERROR_IMPORT_RE_G = /import __furin_bnd_\d+ from "\/app\/src\/pages\/error\.tsx";/g;
const ERROR_IMPORT_CAPTURE_RE = /import (__furin_bnd_\d+) from "\/app\/src\/pages\/error\.tsx";/;
const NOT_FOUND_IMPORT_RE =
  /import __furin_bnd_\d+ from "\/app\/src\/pages\/blog\/not-found\.tsx";/;
const ERROR_BOUNDARY_DEPTH0_RE =
  /segmentBoundaries:\s*\[\s*\{\s*depth:\s*0,\s*error:\s*__furin_bnd_\d+/;
const NOT_FOUND_BOUNDARY_DEPTH1_RE =
  /segmentBoundaries:\s*\[\s*\{\s*depth:\s*1,\s*notFound:\s*__furin_bnd_\d+/;
const ERROR_AND_NOT_FOUND_BOUNDARY_RE =
  /\{\s*depth:\s*0,\s*error:\s*__furin_bnd_\d+,\s*notFound:\s*__furin_bnd_\d+\s*\}/;

describe("generateHydrateEntry — boundary chain emission", () => {
  test("no segmentBoundaries → no `segmentBoundaries:` field in the emitted route", () => {
    const routes = [makeRoute("/", "/app/src/pages/index.tsx")];
    const code = generateHydrateEntry(routes, ROOT, "");
    expect(code).not.toContain("segmentBoundaries:");
  });

  test("route with error boundary at depth 0 → static import + segmentBoundaries field", () => {
    const errorPath = "/app/src/pages/error.tsx";
    const routes = [
      makeRouteWithBoundaries("/", "/app/src/pages/index.tsx", [{ depth: 0, errorPath }]),
    ];
    const code = generateHydrateEntry(routes, ROOT, "");

    // A static import was emitted for the convention file.
    expect(code).toMatch(ERROR_IMPORT_RE);

    // The route entry carries `segmentBoundaries` referencing that identifier.
    expect(code).toMatch(ERROR_BOUNDARY_DEPTH0_RE);
  });

  test("route with notFound boundary at middle depth → static import + field", () => {
    const notFoundPath = "/app/src/pages/blog/not-found.tsx";
    const routes = [
      makeRouteWithBoundaries("/blog/:slug", "/app/src/pages/blog/[slug].tsx", [
        { depth: 1, notFoundPath },
      ]),
    ];
    const code = generateHydrateEntry(routes, ROOT, "");
    expect(code).toMatch(NOT_FOUND_IMPORT_RE);
    expect(code).toMatch(NOT_FOUND_BOUNDARY_DEPTH1_RE);
  });

  test("same convention file shared across two routes → imported exactly once", () => {
    const errorPath = "/app/src/pages/error.tsx";
    const routes = [
      makeRouteWithBoundaries("/", "/app/src/pages/index.tsx", [{ depth: 0, errorPath }]),
      makeRouteWithBoundaries("/about", "/app/src/pages/about.tsx", [{ depth: 0, errorPath }]),
    ];
    const code = generateHydrateEntry(routes, ROOT, "");

    const importMatches = code.match(ERROR_IMPORT_RE_G);
    expect(importMatches?.length ?? 0).toBe(1);

    // Both routes should reference the same identifier.
    const identMatch = code.match(ERROR_IMPORT_CAPTURE_RE);
    const ident = identMatch?.[1];
    expect(ident).toBeDefined();
    const usages = code.match(new RegExp(`error:\\s*${ident}`, "g"));
    expect(usages?.length ?? 0).toBe(2);
  });

  test("error + notFound at the same depth → both idents in one boundary entry", () => {
    const errorPath = "/app/src/pages/error.tsx";
    const notFoundPath = "/app/src/pages/not-found.tsx";
    const routes = [
      makeRouteWithBoundaries("/", "/app/src/pages/index.tsx", [
        { depth: 0, errorPath, notFoundPath },
      ]),
    ];
    const code = generateHydrateEntry(routes, ROOT, "");
    expect(code).toMatch(ERROR_AND_NOT_FOUND_BOUNDARY_RE);
  });
});

// ── Slice 10 — Digest rehydration ─────────────────────────────────────────────
//
// The server embeds `__FURIN_DATA__.__furinError.digest` in the initial HTML
// whenever the loader or shell-render threw. The hydrate entry must forward
// that id onto RouterProvider as `initialDigest`, which in turn passes it to
// the root FurinErrorBoundary. That way, any client-side error that bubbles
// up to the root safety-net displays the SAME digest the server already
// logged — so a user-reported "Error ID: abc123" can be correlated with a
// server log entry.

describe("generateHydrateEntry — digest rehydration (Slice 10)", () => {
  test("reads __furinError.digest off the parsed loader data", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "");
    // The generated code must *extract* the digest from loaderData before
    // passing it to RouterProvider. We tolerate minor formatting (optional
    // chaining, intermediate vars) but the chain must be present somewhere.
    expect(code).toMatch(LOADER_DIGEST_CHAIN_RE);
  });

  test("passes initialDigest prop onto RouterProvider", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "");
    // The prop is emitted as `initialDigest:` in the RouterProvider props
    // object literal (alongside routes, root, initialMatch, initialData).
    expect(code).toMatch(INITIAL_DIGEST_PROP_RE);
  });

  test("the initialDigest value is DERIVED from loader data (not a hardcoded string)", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "");
    // Guard against a regression where someone hardcodes `initialDigest: ""`
    // or similar — the value must be a JS expression referencing loaderData.
    expect(code).toMatch(INITIAL_DIGEST_BOUND_RE);
  });
});

// ── HMR hardening — prevent hydration mismatches on loader-bearing routes ─────
//
// When a _route.tsx with a loader is edited, the server re-evaluates the
// loader and returns fresh data, but the client DOM still carries the old
// __FURIN_DATA__. Without these guards the client re-hydrates with stale
// data and React throws a hydration mismatch.

describe("generateHydrateEntry — HMR hardening", () => {
  test("uses window.__FURIN_ROOT__ as the HMR root persistence mechanism", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "");
    expect(code).toContain("(window as any).__FURIN_ROOT__");
  });

  test("reads window.__FURIN_ROOT__ before deciding to hydrate or reconcile", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "");
    expect(code).toContain("const existingRoot = (window as any).__FURIN_ROOT__;");
  });

  test("stores the React root in window.__FURIN_ROOT__ after initial mount", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "");
    expect(code).toContain("(window as any).__FURIN_ROOT__ = root;");
  });

  test("reconciles (not hydrates) when the root already exists", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "");
    // When existingRoot is truthy: existingRoot.render(app) — no hydrateRoot call
    expect(code).toContain("if (existingRoot) {");
    expect(code).toContain("existingRoot.render(app);");
  });

  test("triggers a loader-data refresh via __FURIN_HMR_REFRESH__ on HMR", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "");
    expect(code).toContain("__FURIN_HMR_REFRESH__");
    expect(code).toContain("requestAnimationFrame(() => hmrRefresh());");
  });

  test("does NOT emit import.meta.hot.accept after the IIFE", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "");
    // The accept handler was removed because Bun re-evaluates the entry module
    // anyway, so the IIFE itself handles both mount and re-render paths.
    expect(code).not.toContain("import.meta.hot.accept(() => {");
  });
});
