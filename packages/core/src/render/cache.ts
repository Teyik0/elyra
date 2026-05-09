import { AsyncLocalStorage } from "node:async_hooks";
import { createLogger } from "../context-logger.ts";
import { type Cache, createRouteCache, type RevalidateType } from "./route-cache.ts";

export type { Cache, CacheInvalidationResult, RevalidateType } from "./route-cache.ts";

export interface ISRCacheEntry {
  generatedAt: number;
  html: string;
  revalidate: number;
}

export interface SsgCacheEntry {
  cachedAt: number;
  html: string;
  /**
   * NDJSON payload identical in shape to what the live `/_furin/data` endpoint
   * emits. Persisted alongside the HTML by the static adapter so SPA navigation
   * on a static-hosted deployment can fetch loader data without going through
   * a runtime endpoint that does not exist on a file server.
   */
  ndjson: string;
  status: number;
}

/** Maximum number of ISR cache entries before LRU eviction kicks in. */
const MAX_ISR_CACHE_SIZE = 1000;
/** Maximum number of SSG cache entries before LRU eviction kicks in. */
const MAX_SSG_CACHE_SIZE = 1000;

const isrRouteCache = createRouteCache<ISRCacheEntry>({
  maxSize: MAX_ISR_CACHE_SIZE,
  name: "render:isr-html",
});
const ssgRouteCache = createRouteCache<SsgCacheEntry>({
  maxSize: MAX_SSG_CACHE_SIZE,
  name: "render:ssg-html",
});

export const isrCache = isrRouteCache.store;
export const ssgCache = ssgRouteCache.store;

/**
 * Gets an ISR cache entry and refreshes its recency so it is treated as
 * recently used by the LRU eviction policy.  Without this, a hot entry that
 * was written early would be evicted before a cold entry written later.
 */
export function getISRCache(key: string): ISRCacheEntry | undefined {
  return isrRouteCache.get(key);
}

/**
 * Gets an SSG cache entry and refreshes its recency so it is treated as
 * recently used by the LRU eviction policy.
 */
export function getSSGCache(key: string): SsgCacheEntry | undefined {
  return ssgRouteCache.get(key);
}

/** Sets an ISR cache entry with LRU eviction. */
export function setISRCache(key: string, entry: ISRCacheEntry): void {
  isrRouteCache.set(key, entry);
}

/** Sets an SSG cache entry with LRU eviction. */
export function setSSGCache(key: string, entry: SsgCacheEntry): void {
  ssgRouteCache.set(key, entry);
}

// ── Build ID ─────────────────────────────────────────────────────────────────

let _buildId = "";

/** Set once at server startup from the CompileContext. */
export function setBuildId(id: string): void {
  _buildId = id;
}

/** Returns the current deployment build ID, or empty string in dev / before set. */
export function getBuildId(): string {
  return _buildId;
}

// ── Pending invalidations (server → client bridge) ───────────────────────────
//
// Per-request scoping via AsyncLocalStorage: furin wraps each request's full
// lifecycle (handler + all hooks) inside `_requestInvalidationScope.run()` so
// that `revalidatePath()` and `consumePendingInvalidations()` share an isolated
// Set per request. The global `_globalPendingInvalidations` is a fallback for
// calls made outside a request context (e.g. scripts, tests, warmup code).

const _requestInvalidationScope = new AsyncLocalStorage<Set<string>>();
const _globalPendingInvalidations = new Set<string>();

function _activeInvalidationSet(): Set<string> {
  return _requestInvalidationScope.getStore() ?? _globalPendingInvalidations;
}

/**
 * Wraps `fn` in a fresh per-request invalidation scope.
 * Call this around the entire Elysia request handle so that all lifecycle
 * hooks share an isolated invalidation Set.
 * @internal
 */
export function _runWithRequestInvalidationScope<T>(fn: () => T): T {
  return _requestInvalidationScope.run(new Set<string>(), fn);
}

/**
 * Consume and clear all pending invalidation paths for the current request.
 * Called by the Elysia `onAfterHandle` hook to populate `X-Furin-Revalidate`.
 * @internal
 */
export function consumePendingInvalidations(): string[] {
  const set = _activeInvalidationSet();
  if (set.size === 0) {
    return [];
  }
  const paths = [...set];
  set.clear();
  return paths;
}

// ── CDN purger hook ───────────────────────────────────────────────────────────

type CachePurger = (paths: string[]) => Promise<void>;
let _cachePurger: CachePurger | null = null;

/**
 * Register a CDN cache purger that will be called whenever `revalidatePath()`
 * is invoked. Intended for use by platform adapters (Vercel, Cloudflare, etc.).
 *
 * The purger is called fire-and-forget — errors are logged but do not affect
 * the HTTP response.
 *
 * @example
 * ```ts
 * // In a Vercel adapter:
 * import { setCachePurger } from "@teyik0/furin";
 * setCachePurger(async (paths) => {
 *   await fetch("https://api.vercel.com/v1/edge-cache/purge", {
 *     method: "POST",
 *     headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` },
 *     body: JSON.stringify({ urls: paths }),
 *   });
 * });
 * ```
 */
export function setCachePurger(fn: CachePurger): void {
  _cachePurger = fn;
}

/** @internal */
export function callCachePurger(paths: string[]): void {
  if (!_cachePurger || paths.length === 0) {
    return;
  }
  _cachePurger(paths).catch((err: unknown) => {
    const logger = createLogger({});
    logger.set({
      furin: {
        action: "cdn_purge_failed",
        paths,
      },
    });
    logger.error(err instanceof Error ? err : new Error(String(err)));
    logger.emit();
  });
}

// ── Path cache invalidators ──────────────────────────────────────────────────

export type CacheInvalidator = Pick<Cache<unknown>, "invalidatePath" | "name">;

const _cacheInvalidators = new Map<string, CacheInvalidator>();

/**
 * Register a cache invalidator that participates in `revalidatePath()`.
 *
 * Internal extension point for render caches that are not backed by the
 * production HTML maps. The returned function unregisters the same instance.
 *
 * @internal
 */
export function registerCacheInvalidator(invalidator: CacheInvalidator): () => void {
  const existing = _cacheInvalidators.get(invalidator.name);
  if (existing !== undefined && existing !== invalidator) {
    throw new Error(
      `Cache invalidator "${invalidator.name}" is already registered with a different instance.`
    );
  }
  if (existing === invalidator) {
    return () => {
      if (_cacheInvalidators.get(invalidator.name) === invalidator) {
        _cacheInvalidators.delete(invalidator.name);
      }
    };
  }
  _cacheInvalidators.set(invalidator.name, invalidator);
  return () => {
    if (_cacheInvalidators.get(invalidator.name) === invalidator) {
      _cacheInvalidators.delete(invalidator.name);
    }
  };
}

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

registerCacheInvalidator(isrRouteCache);
registerCacheInvalidator(ssgRouteCache);

// ── revalidatePath ───────────────────────────────────────────────────────────

/**
 * Programmatically invalidate the server-side cache for a given path.
 *
 * - `type: 'page'` — exact URL match.
 * - `type: 'layout'` — the path itself plus all nested children (prefix match).
 *
 * The `type` parameter is required and must be provided by callers.
 *
 * Works for ISR and SSG routes. SSR routes are always fresh (no server-side
 * cache), but calling this still queues a client-side prefetch invalidation
 * via the `X-Furin-Revalidate` response header.
 *
 * If a CDN purger has been registered via `setCachePurger()`, it will also be
 * called asynchronously to purge the CDN edge cache.
 *
 * @returns `true` if at least one server-side cache entry was removed.
 *
 * @example
 * ```ts
 * // In an API route or webhook handler:
 * import { revalidatePath } from "@teyik0/furin";
 *
 * revalidatePath("/blog/my-post", "page");    // invalidate a single page
 * revalidatePath("/blog", "layout");          // invalidate /blog + all children
 * ```
 */
export function revalidatePath(path: string, type: RevalidateType): boolean {
  // Queue for client-side notification via X-Furin-Revalidate header
  _activeInvalidationSet().add(type === "layout" ? `${path}:layout` : path);

  let deleted = false;
  const purgedPaths: string[] = [];
  for (const invalidator of _cacheInvalidators.values()) {
    const result = invalidator.invalidatePath(path, type);
    deleted = result.deleted || deleted;
    purgedPaths.push(...result.purgedPaths);
  }

  callCachePurger(dedupePaths([...purgedPaths, path]));
  return deleted;
}

/** @internal — resets all module state between tests */
export function __resetCacheState(): void {
  isrCache.clear();
  ssgCache.clear();
  _buildId = "";
  _globalPendingInvalidations.clear();
  _cachePurger = null;
  _cacheInvalidators.clear();
  registerCacheInvalidator(isrRouteCache);
  registerCacheInvalidator(ssgRouteCache);
}
