import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

const emittedLogs: Record<string, unknown>[] = [];

mock.module("evlog", () => ({
  createLogger: (ctx: Record<string, unknown>) => ({
    set: (data: Record<string, unknown>) => {
      Object.assign(ctx, data);
    },
    error: (err: Error) => {
      ctx.error = err;
    },
    emit: () => {
      emittedLogs.push({ ...ctx });
    },
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
    info: () => {},
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
    warn: () => {},
    getContext: () => ctx,
    fork: (_label: string, fn: () => unknown) => fn(),
  }),
}));

mock.module("evlog/elysia", () => ({
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
  useLogger: () => ({ set() {} }),
  evlog: () => (app: unknown) => app,
}));

import {
  __resetCacheState,
  _runWithRequestInvalidationScope,
  consumePendingInvalidations,
  getBuildId,
  getISRCache,
  isrCache,
  revalidatePath,
  setBuildId,
  setCachePurger,
  setISRCache,
  setSSGCache,
  ssgCache,
} from "../src/render/cache";
import {
  __resetDevLoaderCacheState,
  type DevLoaderCacheEntry,
  getDevISRLoaderCache,
  getDevSSGLoaderCache,
  invalidateDevLoaderCacheByPath,
  invalidateDevLoaderCacheBySource,
  setDevISRLoaderCache,
  setDevSSGLoaderCache,
} from "../src/render/dev-cache";
import { __setDevMode } from "../src/runtime-env";

function devEntry(overrides: Partial<DevLoaderCacheEntry>): DevLoaderCacheEntry {
  return {
    dependencies: [],
    generatedAt: Date.now(),
    headers: {},
    loaderData: {},
    mode: "isr",
    revalidate: 60,
    ...overrides,
  };
}

const _originalDevMode = process.env.NODE_ENV !== "production";

beforeAll(() => {
  __setDevMode(false);
});

afterAll(() => {
  __setDevMode(_originalDevMode);
});

afterEach(() => {
  __resetCacheState();
  __resetDevLoaderCacheState();
});

// ── Bullet 1: revalidatePath("page") evicts ISR cache ─────────────────────────

describe("revalidatePath page eviction", () => {
  test("removes an exact ISR cache entry", () => {
    setISRCache("/blog/post", {
      html: "<html>post</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });
    expect(isrCache.has("/blog/post")).toBe(true);

    revalidatePath("/blog/post", "page");

    expect(isrCache.has("/blog/post")).toBe(false);
  });

  test("returns true when a cache entry was deleted", () => {
    setISRCache("/blog/post", {
      html: "<html>post</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });

    const result = revalidatePath("/blog/post", "page");

    expect(result).toBe(true);
  });

  test("returns false when no cache entry existed", () => {
    const result = revalidatePath("/blog/nonexistent", "page");

    expect(result).toBe(false);
  });

  test("removes an exact SSG cache entry", () => {
    setSSGCache("/about", {
      cachedAt: Date.now(),
      html: "<html>about</html>",
      ndjson: "{}\n",
      status: 200,
    });
    expect(ssgCache.has("/about")).toBe(true);

    revalidatePath("/about", "page");

    expect(ssgCache.has("/about")).toBe(false);
  });

  test("does not remove unrelated ISR cache entries", () => {
    setISRCache("/blog/post-1", {
      html: "<html>1</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });
    setISRCache("/blog/post-2", {
      html: "<html>2</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });

    revalidatePath("/blog/post-1", "page");

    expect(isrCache.has("/blog/post-1")).toBe(false);
    expect(isrCache.has("/blog/post-2")).toBe(true);
  });
});

// ── Bullet 2: revalidatePath("layout") prefix-evicts ISR and SSG ──────────────

describe("revalidatePath layout prefix eviction", () => {
  test("evicts all ISR cache entries under the given prefix", () => {
    setISRCache("/blog/post-1", {
      html: "<html>1</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });
    setISRCache("/blog/post-2", {
      html: "<html>2</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });
    setISRCache("/other/page", {
      html: "<html>other</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });

    revalidatePath("/blog", "layout");

    expect(isrCache.has("/blog/post-1")).toBe(false);
    expect(isrCache.has("/blog/post-2")).toBe(false);
    expect(isrCache.has("/other/page")).toBe(true);
  });

  test("evicts SSG cache entries under the given prefix", () => {
    setSSGCache("/blog/post-1", {
      cachedAt: Date.now(),
      html: "<html>1</html>",
      ndjson: "{}\n",
      status: 200,
    });
    setSSGCache("/blog/post-2", {
      cachedAt: Date.now(),
      html: "<html>2</html>",
      ndjson: "{}\n",
      status: 200,
    });
    setSSGCache("/contact", {
      cachedAt: Date.now(),
      html: "<html>contact</html>",
      ndjson: "{}\n",
      status: 200,
    });

    revalidatePath("/blog", "layout");

    expect(ssgCache.has("/blog/post-1")).toBe(false);
    expect(ssgCache.has("/blog/post-2")).toBe(false);
    expect(ssgCache.has("/contact")).toBe(true);
  });

  test("evicts the exact path itself when type is layout", () => {
    setISRCache("/blog", {
      html: "<html>blog index</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });

    revalidatePath("/blog", "layout");

    expect(isrCache.has("/blog")).toBe(false);
  });

  test("returns true when at least one entry was evicted", () => {
    setISRCache("/blog/post", {
      html: "<html>post</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });

    const result = revalidatePath("/blog", "layout");

    expect(result).toBe(true);
  });

  test("returns false when no entries matched the prefix", () => {
    const result = revalidatePath("/blog", "layout");

    expect(result).toBe(false);
  });
});

// ── Bullet 3: revalidatePath queues pendingInvalidations (page) ───────────────

describe("consumePendingInvalidations after page revalidation", () => {
  test("consumePendingInvalidations returns the queued path", () => {
    revalidatePath("/blog/post", "page");

    const paths = consumePendingInvalidations();

    expect(paths).toContain("/blog/post");
  });

  test("second call returns empty array", () => {
    revalidatePath("/blog/post", "page");
    consumePendingInvalidations();

    const second = consumePendingInvalidations();

    expect(second).toEqual([]);
  });

  test("multiple revalidatePath calls accumulate before consume", () => {
    revalidatePath("/page-a", "page");
    revalidatePath("/page-b", "page");

    const paths = consumePendingInvalidations();

    expect(paths).toContain("/page-a");
    expect(paths).toContain("/page-b");
    expect(paths.length).toBe(2);
  });

  test("duplicate paths are deduplicated (Set semantics)", () => {
    revalidatePath("/blog/post", "page");
    revalidatePath("/blog/post", "page");

    const paths = consumePendingInvalidations();

    expect(paths.filter((p) => p === "/blog/post").length).toBe(1);
  });
});

// ── Bullet 4: revalidatePath("layout") queues "path:layout" form ──────────────

describe("consumePendingInvalidations after layout revalidation", () => {
  test("queues the path in :layout form", () => {
    revalidatePath("/blog", "layout");

    const paths = consumePendingInvalidations();

    expect(paths).toContain("/blog:layout");
  });

  test("does not queue the bare path (only the :layout form)", () => {
    revalidatePath("/blog", "layout");

    const paths = consumePendingInvalidations();

    expect(paths).not.toContain("/blog");
    expect(paths).toContain("/blog:layout");
  });

  test("second call returns empty array after consuming", () => {
    revalidatePath("/blog", "layout");
    consumePendingInvalidations();

    const second = consumePendingInvalidations();

    expect(second).toEqual([]);
  });
});

// ── Bullet 5: setCachePurger is called by revalidatePath ──────────────────────

describe("setCachePurger", () => {
  test("purger is called with the revalidated path", async () => {
    const purgedPaths: string[][] = [];
    setCachePurger((paths) => {
      purgedPaths.push(paths);
      return Promise.resolve();
    });

    setISRCache("/blog/post", {
      html: "<html>post</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });
    revalidatePath("/blog/post", "page");

    // Wait a tick for the fire-and-forget async purger
    await Bun.sleep(10);

    expect(purgedPaths.length).toBeGreaterThan(0);
    expect(purgedPaths[0]).toContain("/blog/post");
  });

  test("purger is called even when no cache entry exists", async () => {
    const purgedPaths: string[][] = [];
    setCachePurger((paths) => {
      purgedPaths.push(paths);
      return Promise.resolve();
    });

    revalidatePath("/nonexistent", "page");

    await Bun.sleep(10);

    expect(purgedPaths.length).toBeGreaterThan(0);
    expect(purgedPaths[0]).toContain("/nonexistent");
  });

  test("purger is called with layout paths when type is layout", async () => {
    const purgedPaths: string[][] = [];
    setCachePurger((paths) => {
      purgedPaths.push(paths);
      return Promise.resolve();
    });

    setISRCache("/blog/post-1", {
      html: "<html>1</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });
    setISRCache("/blog/post-2", {
      html: "<html>2</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });
    revalidatePath("/blog", "layout");

    await Bun.sleep(10);

    expect(purgedPaths.length).toBeGreaterThan(0);
    const allPurged = purgedPaths.flat();
    expect(allPurged).toContain("/blog/post-1");
    expect(allPurged).toContain("/blog/post-2");
  });

  test("no purger is registered — revalidatePath does not throw", () => {
    // _cachePurger is null after __resetCacheState()
    expect(() => revalidatePath("/blog/post", "page")).not.toThrow();
  });

  test("purger errors are swallowed (fire-and-forget)", async () => {
    emittedLogs.length = 0;

    setCachePurger(() => Promise.reject(new Error("CDN unavailable")));
    revalidatePath("/blog/post", "page");

    // Two microtask ticks: one for the rejection to settle, one for .catch() to fire.
    // Avoids yielding to a macrotask timer (setTimeout) which lets other tests interleave
    // while _cachePurger is still the rejecting function.
    await Promise.resolve();
    await Promise.resolve();

    expect(emittedLogs.length).toBeGreaterThan(0);
    expect(emittedLogs[0]).toMatchObject({
      furin: { action: "cdn_purge_failed", paths: ["/blog/post"] },
    });
    expect((emittedLogs[0] as { error?: Error }).error).toBeInstanceOf(Error);
  });
});

// ── Bullet 6: setBuildId / getBuildId round-trip ──────────────────────────────

describe("setBuildId / getBuildId", () => {
  test("round-trips the build ID", () => {
    setBuildId("abc123");
    expect(getBuildId()).toBe("abc123");
  });

  test("returns empty string before being set", () => {
    // __resetCacheState() resets _buildId to ""
    expect(getBuildId()).toBe("");
  });

  test("overwriting buildId replaces the previous value", () => {
    setBuildId("v1");
    setBuildId("v2");
    expect(getBuildId()).toBe("v2");
  });
});

// ── Bullet 8: LRU eviction at cache capacity ─────────────────────────────────

describe("ISR LRU eviction", () => {
  test("evicts the oldest entry when ISR cache exceeds 1000 entries", () => {
    const count = 1001;
    for (let i = 0; i < count; i++) {
      setISRCache(`/page-${i}`, {
        html: `<html>${i}</html>`,
        generatedAt: Date.now(),
        revalidate: 60,
      });
    }

    // Entry inserted first must have been evicted
    expect(isrCache.has("/page-0")).toBe(false);
    // Most-recently inserted entry must still be present
    expect(isrCache.has(`/page-${count - 1}`)).toBe(true);
    // Cache must be capped at exactly 1000
    expect(isrCache.size).toBe(1000);
  });

  test("evicts the oldest entry when SSG cache exceeds 1000 entries", () => {
    const count = 1001;
    for (let i = 0; i < count; i++) {
      setSSGCache(`/page-${i}`, {
        cachedAt: Date.now(),
        html: `<html>${i}</html>`,
        ndjson: "{}\n",
        status: 200,
      });
    }

    expect(ssgCache.has("/page-0")).toBe(false);
    expect(ssgCache.has(`/page-${count - 1}`)).toBe(true);
    expect(ssgCache.size).toBe(1000);
  });

  test("getISRCache re-inserts entry at the end so it is not evicted as oldest", () => {
    // Insert 999 entries
    for (let i = 0; i < 999; i++) {
      setISRCache(`/page-${i}`, { html: "", generatedAt: Date.now(), revalidate: 60 });
    }

    // Promote /page-0 to most-recently-used by reading it
    getISRCache("/page-0");

    // Insert one more entry to push size to 1000 (no eviction yet)
    setISRCache("/page-999", { html: "", generatedAt: Date.now(), revalidate: 60 });

    // Insert the 1001st entry — oldest is now /page-1 (not /page-0)
    setISRCache("/page-1000", { html: "", generatedAt: Date.now(), revalidate: 60 });

    expect(isrCache.has("/page-0")).toBe(true); // promoted — still alive
    expect(isrCache.has("/page-1")).toBe(false); // true oldest — evicted
    expect(isrCache.has("/page-1000")).toBe(true);
  });
});

// ── Bullet 7: AsyncLocalStorage request scope isolation ───────────────────────

describe("_runWithRequestInvalidationScope", () => {
  test("isolates concurrent scopes so inner scope does not see outer pending invalidations", () => {
    const result = _runWithRequestInvalidationScope(() => {
      revalidatePath("/outer", "page");
      const inner = _runWithRequestInvalidationScope(() => {
        revalidatePath("/inner", "page");
        return consumePendingInvalidations();
      });
      const outer = consumePendingInvalidations();
      return { inner, outer };
    });

    expect(result.inner).toContain("/inner");
    expect(result.inner).not.toContain("/outer");
    expect(result.outer).toContain("/outer");
    expect(result.outer).not.toContain("/inner");
  });
});

// ── Bullet 8: revalidatePath also clears the dev loader cache ────────────────
//
// In dev mode, ISR/SSG do NOT use the production html caches (`isrCache` /
// `ssgCache`). They use the loader-data caches in dev-cache.ts, keyed by
// `${rootPath}:${urlPath}`. revalidatePath() must invalidate THOSE entries too,
// otherwise dev users see stale data after mutations until the revalidate
// window expires naturally — making `revalidatePath` look broken in dev.

describe("revalidatePath dev loader cache eviction", () => {
  test("revalidatePath('/', 'page') drops dev ISR entries with matching URL path", () => {
    const rootPath = "/Users/me/app/src/pages";
    const key = `${rootPath}:/`;
    setDevISRLoaderCache(key, devEntry({ loaderData: { boards: [] } }));
    expect(getDevISRLoaderCache(key)).toBeDefined();

    revalidatePath("/", "page");

    expect(getDevISRLoaderCache(key)).toBeUndefined();
  });

  test("revalidatePath('/blog/post', 'page') leaves unrelated dev entries intact", () => {
    const rootPath = "/Users/me/app/src/pages";
    setDevISRLoaderCache(`${rootPath}:/blog/post`, devEntry({}));
    setDevISRLoaderCache(`${rootPath}:/`, devEntry({}));
    setDevISRLoaderCache(`${rootPath}:/blog/other`, devEntry({}));

    revalidatePath("/blog/post", "page");

    expect(getDevISRLoaderCache(`${rootPath}:/blog/post`)).toBeUndefined();
    expect(getDevISRLoaderCache(`${rootPath}:/`)).toBeDefined();
    expect(getDevISRLoaderCache(`${rootPath}:/blog/other`)).toBeDefined();
  });

  test("revalidatePath('/blog', 'layout') drops the path itself and every descendant", () => {
    const rootPath = "/Users/me/app/src/pages";
    setDevISRLoaderCache(`${rootPath}:/blog`, devEntry({}));
    setDevISRLoaderCache(`${rootPath}:/blog/post-1`, devEntry({}));
    setDevISRLoaderCache(`${rootPath}:/blog/post-2`, devEntry({}));
    setDevISRLoaderCache(`${rootPath}:/other`, devEntry({}));

    revalidatePath("/blog", "layout");

    expect(getDevISRLoaderCache(`${rootPath}:/blog`)).toBeUndefined();
    expect(getDevISRLoaderCache(`${rootPath}:/blog/post-1`)).toBeUndefined();
    expect(getDevISRLoaderCache(`${rootPath}:/blog/post-2`)).toBeUndefined();
    expect(getDevISRLoaderCache(`${rootPath}:/other`)).toBeDefined();
  });

  test("revalidatePath also clears matching dev SSG entries (symmetry with ISR)", () => {
    const rootPath = "/Users/me/app/src/pages";
    setDevSSGLoaderCache(`${rootPath}:/about`, devEntry({ mode: "ssg" }));
    setDevSSGLoaderCache(`${rootPath}:/contact`, devEntry({ mode: "ssg" }));

    revalidatePath("/about", "page");

    expect(getDevSSGLoaderCache(`${rootPath}:/about`)).toBeUndefined();
    expect(getDevSSGLoaderCache(`${rootPath}:/contact`)).toBeDefined();
  });

  test("handles Windows-style rootPath (contains 'C:/' early in the key)", () => {
    // Cache keys are `${rootPath}:${urlPath}`. On Windows the rootPath itself
    // contains `:/` after the drive letter. The extractor must use the LAST
    // ":/" as the boundary to find the URL path correctly.
    const winRootPath = "C:/Users/me/app/src/pages";
    const key = `${winRootPath}:/blog/post`;
    setDevISRLoaderCache(key, devEntry({}));
    setDevISRLoaderCache(`${winRootPath}:/other`, devEntry({}));

    revalidatePath("/blog/post", "page");

    expect(getDevISRLoaderCache(key)).toBeUndefined();
    expect(getDevISRLoaderCache(`${winRootPath}:/other`)).toBeDefined();
  });

  test("direct dev path invalidation reports cleared cache keys and cleans dependency indexes", () => {
    const rootPath = "/Users/me/app/src/pages";
    const dep = "/Users/me/app/src/pages/blog/post.tsx";
    const isrKey = `${rootPath}:/blog/post`;
    const ssgKey = `${rootPath}:/blog/post-static`;
    setDevISRLoaderCache(isrKey, devEntry({ dependencies: [dep] }));
    setDevSSGLoaderCache(ssgKey, devEntry({ dependencies: [dep], mode: "ssg" }));

    const result = invalidateDevLoaderCacheByPath("/blog", "layout");

    expect(result).toEqual({ cleared: [isrKey, ssgKey], isr: 1, ssg: 1 });
    expect(invalidateDevLoaderCacheBySource(dep)).toEqual({ cleared: [], isr: 0, ssg: 0 });
  });

  test("direct dev path invalidation ignores malformed cache keys defensively", () => {
    setDevISRLoaderCache("not-a-route-key", devEntry({}));

    const result = invalidateDevLoaderCacheByPath("/blog/post", "page");

    expect(result).toEqual({ cleared: [], isr: 0, ssg: 0 });
    expect(getDevISRLoaderCache("not-a-route-key")).toBeDefined();
  });
});
