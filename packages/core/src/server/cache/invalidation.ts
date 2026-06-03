import { AsyncLocalStorage } from "node:async_hooks";
import { createLogger } from "../context-logger";
import { devISRLoaderCache, devSSGLoaderCache } from "./dev-loader";
import { isrRouteCache } from "./isr";
import { clearCacheInvalidators, getCacheInvalidators, registerCacheInvalidator } from "./registry";
import type { RevalidateType } from "./route-cache";
import { ssgRouteCache } from "./ssg";

// Register core caches at module load time so revalidatePath works out of the box.
registerCacheInvalidator(isrRouteCache);
registerCacheInvalidator(ssgRouteCache);
registerCacheInvalidator(devISRLoaderCache);
registerCacheInvalidator(devSSGLoaderCache);

// ── Build ID ─────────────────────────────────────────────────────────────────

let _buildId = "";

export function setBuildId(id: string): void {
  _buildId = id;
}

export function getBuildId(): string {
  return _buildId;
}

// ── Pending invalidations (server → client bridge) ───────────────────────────

const _requestInvalidationScope = new AsyncLocalStorage<Set<string>>();
const _globalPendingInvalidations = new Set<string>();

function _activeInvalidationSet(): Set<string> {
  return _requestInvalidationScope.getStore() ?? _globalPendingInvalidations;
}

export function _runWithRequestInvalidationScope<T>(fn: () => T): T {
  return _requestInvalidationScope.run(new Set<string>(), fn);
}

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

export function setCachePurger(fn: CachePurger): void {
  _cachePurger = fn;
}

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

// ── revalidatePath ───────────────────────────────────────────────────────────

export function revalidatePath(path: string, type: RevalidateType): boolean {
  _activeInvalidationSet().add(type === "layout" ? `${path}:layout` : path);

  let deleted = false;
  const purgedPaths: string[] = [];
  for (const invalidator of getCacheInvalidators()) {
    const result = invalidator.invalidatePath(path, type);
    deleted = result.deleted || deleted;
    purgedPaths.push(...result.purgedPaths);
  }

  callCachePurger(dedupePaths([...purgedPaths, path]));
  return deleted;
}

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

/** @internal — resets all module state between tests */
export function __resetCacheState(): void {
  isrRouteCache.clear();
  ssgRouteCache.clear();
  devISRLoaderCache.clear();
  devSSGLoaderCache.clear();
  _buildId = "";
  _globalPendingInvalidations.clear();
  _cachePurger = null;
  clearCacheInvalidators();
  registerCacheInvalidator(isrRouteCache);
  registerCacheInvalidator(ssgRouteCache);
  registerCacheInvalidator(devISRLoaderCache);
  registerCacheInvalidator(devSSGLoaderCache);
}
