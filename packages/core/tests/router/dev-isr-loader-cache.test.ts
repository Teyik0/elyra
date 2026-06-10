import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("evlog/elysia", () => ({
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
  useLogger: () => ({ set() {} }),
  evlog: () => (app: unknown) => app,
}));

import { Elysia } from "elysia";
import {
  __resetCacheState,
  __resetDevLoaderCacheState,
  type DevLoaderCacheEntry,
  getAllDevSSGLoaderEntries,
  getDevISRLoaderCache,
  getDevSSGLoaderCache,
  invalidateDevLoaderCacheBySource,
  isDevLoaderCacheFresh,
  setDevISRLoaderCache,
  setDevSSGLoaderCache,
} from "furin/server/cache";
import { createDevInspectorPlugin } from "furin/server/dev-inspector";
import { registerDevPagePlugin } from "furin/server/dev-page-plugin";
import { __resetTemplateState, setProductionTemplateContent } from "furin/server/render/template";
import { createRoutePlugin, scanPages } from "furin/server/router";
import { __setDevMode, IS_DEV } from "furin/server/runtime-env";

registerDevPagePlugin();

const FIXTURES_DIR = join(import.meta.dirname, "../fixtures/pages");
const TEST_TEMPLATE =
  '<!DOCTYPE html><html><head><!--FURIN_HEAD--></head><body><div id="root"><!--FURIN_HTML--></div><!--FURIN_TAIL--></body></html>';
const TIMESTAMP_RE = /data-timestamp="(\d+)"/;

let originalDevMode: boolean;
beforeAll(() => {
  originalDevMode = IS_DEV;
  __setDevMode(false);
  setProductionTemplateContent(TEST_TEMPLATE);
});
beforeEach(() => {
  __resetCacheState();
  __resetDevLoaderCacheState();
});
afterAll(() => {
  __setDevMode(originalDevMode);
  __resetTemplateState();
});

/**
 * Dev "Live ISR" — the ISR cache in dev stores the LOADER OUTPUT, not the
 * assembled HTML.  This decouples the data-side caching (the actual win) from
 * the rendered HTML, which must always embed the freshest dev chunk URL.
 *
 * Public-interface assertion: within a `revalidate` window, two requests to
 * the same ISR route produce identical loader-derived data.  We verify this
 * through the rendered HTML — `data-timestamp` is the loader's `Date.now()`
 * snapshot, so a cache miss on request #2 would produce a strictly greater
 * timestamp.
 */
describe("dev ISR loader cache", () => {
  test("loader cache hit in dev preserves loader data across requests", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const isrRoute = result.routes.find((r) => r.pattern === "/isr-page" && r.mode === "isr");
    if (!isrRoute) {
      throw new Error("No /isr-page fixture with mode=isr");
    }

    __setDevMode(true);
    try {
      const app = new Elysia().use(createRoutePlugin(isrRoute, result.root));

      // Request #1 — cold cache miss; loader runs, snapshot captured.
      const res1 = await app.handle(new Request("http://localhost/isr-page"));
      expect(res1.status).toBe(200);
      const html1 = await res1.text();
      const ts1Match = html1.match(TIMESTAMP_RE);
      expect(ts1Match).not.toBeNull();
      const ts1 = ts1Match?.[1];

      // Sleep long enough that Date.now() would advance on a fresh loader call.
      await Bun.sleep(20);

      // Request #2 — must be a loader-cache HIT; the timestamp embedded in
      // the HTML must be byte-equal to request #1's.  A cache miss would
      // produce a strictly greater value because of the sleep above.
      const res2 = await app.handle(new Request("http://localhost/isr-page"));
      expect(res2.status).toBe(200);
      const html2 = await res2.text();
      const ts2Match = html2.match(TIMESTAMP_RE);
      expect(ts2Match).not.toBeNull();
      const ts2 = ts2Match?.[1];

      expect(ts2).toBe(ts1);
    } finally {
      __setDevMode(false);
    }
  });

  /**
   * Source-aware invalidation: when a file in a cache entry's dependency
   * chain (page file, intermediate `_route.tsx`, or `root.tsx`) changes, the
   * entry must be dropped so the next request re-runs the loader chain
   * against the latest module code.
   *
   * Public-interface assertion: after `invalidateDevLoaderCacheBySource(path)`
   * is called for any dependency path, the cache lookup returns undefined and
   * the next request produces a strictly greater timestamp.
   */
  test("source change in the dependency chain invalidates the cached entry", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const isrRoute = result.routes.find((r) => r.pattern === "/isr-page" && r.mode === "isr");
    if (!isrRoute) {
      throw new Error("No /isr-page fixture with mode=isr");
    }

    __setDevMode(true);
    try {
      const app = new Elysia().use(createRoutePlugin(isrRoute, result.root));

      // Request #1 — populates the cache.
      const res1 = await app.handle(new Request("http://localhost/isr-page"));
      const html1 = await res1.text();
      const ts1 = html1.match(TIMESTAMP_RE)?.[1];
      expect(ts1).toBeDefined();

      // The cache entry must record the page file as a dependency so an edit
      // to that file can invalidate it.  Root.tsx is also part of the chain.
      const isrCacheKey = `${result.root.path}:/isr-page`;
      const cached = getDevISRLoaderCache(isrCacheKey);
      expect(cached).toBeDefined();
      expect(cached?.dependencies).toContain(isrRoute.path);
      expect(cached?.dependencies).toContain(result.root.path);

      // Simulate the dev-page-plugin re-evaluating the page file.  The cache
      // must drop the dependent entry — no entry should remain for the key.
      invalidateDevLoaderCacheBySource(isrRoute.path);
      expect(getDevISRLoaderCache(isrCacheKey)).toBeUndefined();

      // Sleep so a fresh loader call produces a strictly greater timestamp.
      await Bun.sleep(20);

      // Request #2 — cache miss, loader re-runs, fresh timestamp.
      const res2 = await app.handle(new Request("http://localhost/isr-page"));
      const html2 = await res2.text();
      const ts2 = html2.match(TIMESTAMP_RE)?.[1];
      expect(ts2).toBeDefined();
      expect(Number(ts2)).toBeGreaterThan(Number(ts1));
    } finally {
      __setDevMode(false);
    }
  });

  /**
   * Edge case: editing a sibling page's source file MUST NOT invalidate the
   * unrelated cached entry.  This is what makes dependency tracking valuable
   * over a global "any edit nukes everything" strategy: only entries whose
   * actual dependency chain includes the changed file get dropped.
   */
  test("source change in an unrelated file does not invalidate the cached entry", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const isrRoute = result.routes.find((r) => r.pattern === "/isr-page" && r.mode === "isr");
    if (!isrRoute) {
      throw new Error("No /isr-page fixture with mode=isr");
    }

    __setDevMode(true);
    try {
      const app = new Elysia().use(createRoutePlugin(isrRoute, result.root));

      // Warm the cache.
      const res1 = await app.handle(new Request("http://localhost/isr-page"));
      const html1 = await res1.text();
      const ts1 = html1.match(TIMESTAMP_RE)?.[1];
      expect(ts1).toBeDefined();
      const isrCacheKey = `${result.root.path}:/isr-page`;
      expect(getDevISRLoaderCache(isrCacheKey)).toBeDefined();

      // Pretend an unrelated file in the same `pages` directory was edited.
      // It is NOT part of the /isr-page dependency chain, so the entry must
      // survive.
      invalidateDevLoaderCacheBySource("/some/unrelated/file.tsx");
      expect(getDevISRLoaderCache(isrCacheKey)).toBeDefined();

      await Bun.sleep(20);

      // Request #2 — cache hit, same timestamp.
      const res2 = await app.handle(new Request("http://localhost/isr-page"));
      const html2 = await res2.text();
      const ts2 = html2.match(TIMESTAMP_RE)?.[1];
      expect(ts2).toBe(ts1);
    } finally {
      __setDevMode(false);
    }
  });

  /**
   * Inspector endpoint: a dev-only Elysia route that surfaces the active
   * entries of both ISR and SSG dev loader caches.  Designed to back a
   * future browser DevTools panel — the JSON shape must be stable and
   * carry enough information for a UI to render an entry list with
   * freshness, dependencies, and a data preview.
   */
  test("GET /__furin/_inspect/isr returns active entries with the documented shape", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const isrRoute = result.routes.find((r) => r.pattern === "/isr-page" && r.mode === "isr");
    if (!isrRoute) {
      throw new Error("No /isr-page fixture with mode=isr");
    }

    __setDevMode(true);
    try {
      const app = new Elysia()
        .use(createRoutePlugin(isrRoute, result.root))
        .use(createDevInspectorPlugin());

      // Warm the ISR cache for /isr-page.
      const warmRes = await app.handle(new Request("http://localhost/isr-page"));
      expect(warmRes.status).toBe(200);

      // Inspector returns 200 + JSON content type.
      const inspectRes = await app.handle(new Request("http://localhost/__furin/_inspect/isr"));
      expect(inspectRes.status).toBe(200);
      expect(inspectRes.headers.get("content-type")).toContain("application/json");

      const body = (await inspectRes.json()) as Array<{
        dataPreview: unknown;
        dependencies: string[];
        generatedAt: number;
        isFresh: boolean;
        key: string;
        mode: "isr" | "ssg";
        revalidate: number;
      }>;

      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);

      const [entry] = body;
      expect(entry?.key).toBe(`${result.root.path}:/isr-page`);
      expect(entry?.mode).toBe("isr");
      expect(entry?.isFresh).toBe(true);
      expect(entry?.revalidate).toBe(60);
      expect(typeof entry?.generatedAt).toBe("number");
      expect(entry?.dependencies).toContain(isrRoute.path);
      expect(entry?.dependencies).toContain(result.root.path);
      // dataPreview must include the loader's `timestamp` field — proof the
      // panel surfaces real loader output, not just metadata.
      expect((entry?.dataPreview as Record<string, unknown>)?.timestamp).toBeDefined();
    } finally {
      __setDevMode(false);
    }
  });
});

/**
 * Dev "Live SSG" — mirrors the Live ISR semantics but with `revalidate:
 * Number.POSITIVE_INFINITY`, so cache entries stay fresh until source-aware
 * invalidation drops them.  This brings dev-mode SSG behaviour in line with
 * production: a loader runs ONCE per cache key (until a source file in its
 * dependency chain changes), instead of re-running on every refresh.
 *
 * Public-interface assertion: two consecutive requests to the same SSG route
 * produce identical loader-derived data — proven by byte-equal `data-timestamp`
 * across the two responses (the loader captures `Date.now()`, so a cache miss
 * after a sleep would yield a strictly greater value).
 */
describe("dev SSG loader cache", () => {
  test("loader cache hit in dev preserves SSG loader data across requests", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const ssgRoute = result.routes.find(
      (r) => r.pattern === "/ssg-loader-page" && r.mode === "ssg"
    );
    if (!ssgRoute) {
      throw new Error("No /ssg-loader-page fixture with mode=ssg");
    }

    __setDevMode(true);
    try {
      const app = new Elysia().use(createRoutePlugin(ssgRoute, result.root));

      // Request #1 — cold cache miss; loader runs, snapshot captured.
      const res1 = await app.handle(new Request("http://localhost/ssg-loader-page"));
      expect(res1.status).toBe(200);
      const html1 = await res1.text();
      const ts1 = html1.match(TIMESTAMP_RE)?.[1];
      expect(ts1).toBeDefined();

      // Sleep long enough that Date.now() would advance on a fresh loader call.
      await Bun.sleep(20);

      // Request #2 — must be a loader-cache HIT; the timestamp embedded in
      // the HTML must be byte-equal to request #1's.  A cache miss would
      // produce a strictly greater value because of the sleep above.
      const res2 = await app.handle(new Request("http://localhost/ssg-loader-page"));
      expect(res2.status).toBe(200);
      const html2 = await res2.text();
      const ts2 = html2.match(TIMESTAMP_RE)?.[1];
      expect(ts2).toBe(ts1);

      // The cache entry MUST be tagged as ssg (not isr) so the inspector and
      // invalidation paths surface the right kind.
      const ssgCacheKey = `${result.root.path}:/ssg-loader-page`;
      const cached = getDevSSGLoaderCache(ssgCacheKey);
      expect(cached?.mode).toBe("ssg");
      // SSG entries are forever-fresh (until source invalidation).
      expect(cached?.revalidate).toBe(Number.POSITIVE_INFINITY);
    } finally {
      __setDevMode(false);
    }
  });

  /**
   * Source-aware invalidation: editing the SSG page file (or any file in the
   * cache entry's dependency chain) MUST drop the entry so the next request
   * re-runs the loader.  This proves SSG dev cache participates in the same
   * invalidation pipeline as ISR — no parallel mechanism, no drift.
   */
  test("source change in the dependency chain invalidates the cached SSG entry", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const ssgRoute = result.routes.find(
      (r) => r.pattern === "/ssg-loader-page" && r.mode === "ssg"
    );
    if (!ssgRoute) {
      throw new Error("No /ssg-loader-page fixture with mode=ssg");
    }

    __setDevMode(true);
    try {
      const app = new Elysia().use(createRoutePlugin(ssgRoute, result.root));

      // Request #1 — populates the cache.
      const res1 = await app.handle(new Request("http://localhost/ssg-loader-page"));
      const html1 = await res1.text();
      const ts1 = html1.match(TIMESTAMP_RE)?.[1];
      expect(ts1).toBeDefined();

      // Dependency chain must include the page file and root.tsx so an edit
      // to either invalidates the entry.
      const ssgCacheKey = `${result.root.path}:/ssg-loader-page`;
      const cached = getDevSSGLoaderCache(ssgCacheKey);
      expect(cached).toBeDefined();
      expect(cached?.dependencies).toContain(ssgRoute.path);
      expect(cached?.dependencies).toContain(result.root.path);

      // Simulate the dev-page-plugin re-evaluating the page file.
      const outcome = invalidateDevLoaderCacheBySource(ssgRoute.path);
      expect(outcome.ssg).toBe(1);
      expect(getDevSSGLoaderCache(ssgCacheKey)).toBeUndefined();

      // Sleep so a fresh loader call produces a strictly greater timestamp.
      await Bun.sleep(20);

      // Request #2 — cache miss, loader re-runs, fresh timestamp.
      const res2 = await app.handle(new Request("http://localhost/ssg-loader-page"));
      const html2 = await res2.text();
      const ts2 = html2.match(TIMESTAMP_RE)?.[1];
      expect(ts2).toBeDefined();
      expect(Number(ts2)).toBeGreaterThan(Number(ts1));
    } finally {
      __setDevMode(false);
    }
  });
});

/**
 * Unit tests for the SSG dev loader cache and the shared cache primitives
 * that the ISR tests above leave uncovered.  Exercises:
 *
 * — `getDevSSGLoaderCache` / `setDevSSGLoaderCache`
 * — SSG branch of `invalidateDevLoaderCacheBySource`
 * — `isDevLoaderCacheFresh` helper
 * — `getAllDevSSGLoaderEntries` helper
 * — `setDevISRLoaderCache` overwrite path (drops stale reverse-index links)
 */
describe("dev cache primitives", () => {
  const makeEntry = (overrides: Partial<DevLoaderCacheEntry> | undefined): DevLoaderCacheEntry => ({
    dependencies: ["/some/page.tsx", "/some/root.tsx"],
    generatedAt: Date.now(),
    headers: {},
    loaderData: { value: "data" },
    mode: "ssg",
    revalidate: Number.POSITIVE_INFINITY,
    ...(overrides ?? {}),
  });

  test("setDevSSGLoaderCache / getDevSSGLoaderCache round-trip", () => {
    const entry = makeEntry(undefined);
    setDevSSGLoaderCache("/ssg-route", entry);
    expect(getDevSSGLoaderCache("/ssg-route")).toBe(entry);
    expect(getDevSSGLoaderCache("/other")).toBeUndefined();
  });

  test("isDevLoaderCacheFresh returns true for SSG entries (revalidate = Infinity)", () => {
    const entry = makeEntry(undefined);
    expect(isDevLoaderCacheFresh(entry)).toBe(true);
  });

  test("isDevLoaderCacheFresh returns false for stale ISR entries", () => {
    const entry = makeEntry({
      mode: "isr",
      revalidate: 1,
      generatedAt: Date.now() - 2000, // 2 s ago — beyond the 1 s window
    });
    expect(isDevLoaderCacheFresh(entry)).toBe(false);
  });

  test("invalidateDevLoaderCacheBySource drops SSG entries whose dep chain includes the file", () => {
    const entry = makeEntry({ dependencies: ["/pages/ssg.tsx", "/pages/root.tsx"] });
    setDevSSGLoaderCache("/ssg-route", entry);
    expect(getDevSSGLoaderCache("/ssg-route")).toBeDefined();

    const result = invalidateDevLoaderCacheBySource("/pages/ssg.tsx");
    expect(result.ssg).toBe(1);
    expect(result.isr).toBe(0);
    expect(result.cleared).toContain("/ssg-route");
    expect(getDevSSGLoaderCache("/ssg-route")).toBeUndefined();
  });

  test("invalidateDevLoaderCacheBySource is SSG / ISR independent — only the affected kind is cleared", () => {
    const isrEntry = makeEntry({ mode: "isr", revalidate: 60, dependencies: ["/shared.tsx"] });
    const ssgEntry = makeEntry({ dependencies: ["/shared.tsx"] });

    setDevISRLoaderCache("/isr-route", isrEntry);
    setDevSSGLoaderCache("/ssg-route", ssgEntry);

    // Invalidate the ISR entry.
    const result1 = invalidateDevLoaderCacheBySource("/shared.tsx");
    // Both keys share the dependency. The ISR entry is found first and removed;
    // then the SSG entry is found and removed in the same pass.
    expect(result1.isr + result1.ssg).toBe(2);
    expect(getDevISRLoaderCache("/isr-route")).toBeUndefined();
    expect(getDevSSGLoaderCache("/ssg-route")).toBeUndefined();
  });

  test("getAllDevSSGLoaderEntries returns all live SSG entries", () => {
    const a = makeEntry({ loaderData: { page: "a" } });
    const b = makeEntry({ loaderData: { page: "b" } });
    setDevSSGLoaderCache("/a", a);
    setDevSSGLoaderCache("/b", b);

    const entries = getAllDevSSGLoaderEntries();
    expect(entries).toHaveLength(2);
    const keys = entries.map(([k]) => k);
    expect(keys).toContain("/a");
    expect(keys).toContain("/b");
  });

  test("overwriting an ISR entry with setDevISRLoaderCache cleans up the stale reverse-index (line-84 branch)", () => {
    const dep1 = "/old-dep.tsx";
    const dep2 = "/new-dep.tsx";

    const v1 = makeEntry({ mode: "isr", revalidate: 60, dependencies: [dep1] });
    setDevISRLoaderCache("/isr-route", v1);

    // dep1 must now be in the reverse index.
    expect(invalidateDevLoaderCacheBySource(dep1).isr).toBe(1);

    // Re-set with a different dependency set — the old dep must be removed.
    const v2 = makeEntry({ mode: "isr", revalidate: 60, dependencies: [dep2] });
    setDevISRLoaderCache("/isr-route", v2);

    // dep1 must NOT trigger invalidation any more (stale link was cleaned).
    expect(invalidateDevLoaderCacheBySource(dep1)).toEqual({ cleared: [], isr: 0, ssg: 0 });
    // dep2 MUST trigger invalidation.
    // (Re-set to restore before checking dep2)
    setDevISRLoaderCache("/isr-route", v2);
    expect(invalidateDevLoaderCacheBySource(dep2).isr).toBe(1);
  });
});

/**
 * `isDevLoaderCacheValid` is the pre-read check used by both
 * `renderDevISRWithLoaderCache` and `renderDevSSGWithLoaderCache`.  It folds
 * two distinct invariants into a single decision:
 *
 *   1. Time-based freshness  — same as `isDevLoaderCacheFresh` (already covered
 *      by the tests above).  SSG entries always pass this check because their
 *      `revalidate` is `Number.POSITIVE_INFINITY`.
 *
 *   2. Source-based freshness — every file in `entry.dependencies` is `stat`-ed
 *      against `entry.generatedAt`.  If any dep's `mtimeMs` is greater, the
 *      cache entry is stale: the user has edited a file that contributed to
 *      the loader output, and the next request must re-run the chain.
 *
 * This second check is what makes dev ISR/SSG behave correctly across a
 * `root.tsx` edit (or any other dependency).  It does NOT rely on Bun's plugin
 * `onLoad` ordering or `--hot` cache invalidation timing — a fresh `stat()` is
 * the source of truth on every request.
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isDevLoaderCacheValid } from "furin/server/cache";

describe("isDevLoaderCacheValid", () => {
  let tmpDir: string;

  function makeTmpDir(): string {
    return mkdtempSync(join(tmpdir(), "furin-cache-validity-"));
  }

  // Each test gets its own tmp dir so concurrent runs do not collide.
  function setupTmp(): { dir: string; cleanup: () => void } {
    const dir = makeTmpDir();
    return {
      dir,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  test("returns true when entry is time-fresh AND every dep is older than generatedAt", () => {
    const { dir, cleanup } = setupTmp();
    tmpDir = dir;
    try {
      const dep = join(dir, "dep.tsx");
      writeFileSync(dep, "// initial content");
      // Pin file mtime to 5s ago so it is unambiguously older than `generatedAt`.
      const fiveSecAgo = (Date.now() - 5000) / 1000;
      utimesSync(dep, fiveSecAgo, fiveSecAgo);

      const entry: DevLoaderCacheEntry = {
        dependencies: [dep],
        generatedAt: Date.now(),
        headers: {},
        loaderData: { x: 1 },
        mode: "isr",
        revalidate: 60,
      };
      expect(isDevLoaderCacheValid(entry)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("returns false when a dep's mtime is newer than generatedAt", () => {
    const { dir, cleanup } = setupTmp();
    tmpDir = dir;
    try {
      const dep = join(dir, "dep.tsx");
      writeFileSync(dep, "// initial content");

      const oldGeneratedAt = Date.now() - 10_000;
      // Touch the file to a time AFTER oldGeneratedAt (= 5s ago vs 10s ago).
      const fiveSecAgo = (Date.now() - 5000) / 1000;
      utimesSync(dep, fiveSecAgo, fiveSecAgo);

      const entry: DevLoaderCacheEntry = {
        dependencies: [dep],
        generatedAt: oldGeneratedAt,
        headers: {},
        loaderData: { x: 1 },
        mode: "isr",
        revalidate: 60,
      };
      expect(isDevLoaderCacheValid(entry)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("returns false when entry is past its revalidate window even if deps are unchanged", () => {
    const { dir, cleanup } = setupTmp();
    tmpDir = dir;
    try {
      const dep = join(dir, "dep.tsx");
      writeFileSync(dep, "// initial content");

      const entry: DevLoaderCacheEntry = {
        dependencies: [dep],
        generatedAt: Date.now() - 120_000, // 2 minutes ago
        headers: {},
        loaderData: { x: 1 },
        mode: "isr",
        revalidate: 60, // 1 minute window
      };
      expect(isDevLoaderCacheValid(entry)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("SSG entries (revalidate = Infinity) are still invalidated by a dep mtime change", () => {
    const { dir, cleanup } = setupTmp();
    tmpDir = dir;
    try {
      const dep = join(dir, "dep.tsx");
      writeFileSync(dep, "// initial content");

      const oldGeneratedAt = Date.now() - 10_000;
      const fiveSecAgo = (Date.now() - 5000) / 1000;
      utimesSync(dep, fiveSecAgo, fiveSecAgo);

      const entry: DevLoaderCacheEntry = {
        dependencies: [dep],
        generatedAt: oldGeneratedAt,
        headers: {},
        loaderData: { x: 1 },
        mode: "ssg",
        revalidate: Number.POSITIVE_INFINITY,
      };
      // Time-fresh forever, but the dep is newer → invalid.
      expect(isDevLoaderCacheValid(entry)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("returns false when a dep file no longer exists on disk", () => {
    const { dir, cleanup } = setupTmp();
    tmpDir = dir;
    try {
      const missing = join(dir, "deleted.tsx");
      // Intentionally never created.

      const entry: DevLoaderCacheEntry = {
        dependencies: [missing],
        generatedAt: Date.now(),
        headers: {},
        loaderData: { x: 1 },
        mode: "isr",
        revalidate: 60,
      };
      expect(isDevLoaderCacheValid(entry)).toBe(false);
    } finally {
      cleanup();
    }
  });

  // Reference tmpDir to satisfy lint (unused let otherwise).
  test("(harness sanity) tmpDir is set in each test", () => {
    expect(typeof tmpDir).toBe("string");
  });
});

/**
 * `computeRouteDependencies` must not produce phantom entries.  Each candidate
 * extension (`_route.tsx`, `_route.ts`, `_route.jsx`, `_route.js`) is checked,
 * but only the ones that actually exist on disk get into the dependency list.
 *
 * Why this matters: `isDevLoaderCacheValid` treats `statSync` failures as a
 * conservative "invalid" verdict.  If a non-existent path were stored as a
 * dependency, every cache read would throw on it and force a miss — silently
 * killing the dev ISR/SSG cache for every page in a subdirectory.  This test
 * is the regression guard for that footgun.
 */
import { existsSync as fileExistsSync } from "node:fs";

import { computeRouteDependencies } from "furin/server/router";

describe("computeRouteDependencies", () => {
  test("only returns paths that exist on disk for nested routes", () => {
    // The `nested/deep` fixture has exactly ONE `_route.tsx` per intermediate
    // directory — the .ts / .jsx / .js variants are absent.  The current
    // implementation pushes ALL four candidates which would invalidate the
    // cache permanently; this test pins down "only existing files".
    const pagesDir = join(import.meta.dirname, "../fixtures/pages");
    const pagePath = join(pagesDir, "nested/deep/index.tsx");
    const rootPath = join(pagesDir, "root.tsx");

    const deps = computeRouteDependencies(pagePath, rootPath);

    for (const dep of deps) {
      expect(fileExistsSync(dep)).toBe(true);
    }
    // Sanity: page + root + 2 intermediate _route.tsx (nested + nested/deep).
    expect(deps).toHaveLength(4);
  });

  test("page at the pages root has only the page and root files as deps", () => {
    const pagesDir = join(import.meta.dirname, "../fixtures/pages");
    const pagePath = join(pagesDir, "isr-page.tsx");
    const rootPath = join(pagesDir, "root.tsx");

    const deps = computeRouteDependencies(pagePath, rootPath);
    expect(deps).toEqual([pagePath, rootPath]);
  });
});
