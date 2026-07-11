import { createLogger } from "../context-logger";
import {
  __clearInstanceRegistry,
  allInstances,
  allStateBuckets,
  currentInstance,
  requestPendingInvalidations,
  runWithInstanceScope,
  withInstance,
} from "../instance.ts";
import { clearDevLoaderCaches } from "./dev-loader";
import { isrRouteCache } from "./isr";
import { getCacheInvalidators } from "./registry";
import type { RevalidateType } from "./route-cache";
import { ssgRouteCache } from "./ssg";

// ── Build ID ─────────────────────────────────────────────────────────────────
// Lives on the furin instance — each mounted app reports its own build ID.

export function setBuildId(id: string): void {
  currentInstance().buildId = id;
}

export function getBuildId(): string {
  return currentInstance().buildId;
}

// ── Pending invalidations (server → client bridge) ───────────────────────────
// The per-request set lives in the instance request scope (see instance.ts);
// outside a request scope invalidations accumulate in a process-global set.

const _globalPendingInvalidations = new Set<string>();

function _activeInvalidationSet(): Set<string> {
  return requestPendingInvalidations() ?? _globalPendingInvalidations;
}

export function _runWithRequestInvalidationScope<T>(fn: () => T): T {
  return runWithInstanceScope(currentInstance(), fn);
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
// Process-global on purpose: the CDN sits in front of every mounted app.

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

/**
 * Invalidates `path` across EVERY mounted furin instance — paths are logical
 * (unprefixed), and with shared data two apps can legitimately render the same
 * logical path. This mirrors the historical shared-cache behaviour. Each
 * instance's invalidation runs inside its own scope so cache `onDelete` hooks
 * (auto-invalidate unregistration) hit the owning instance's registry.
 */
export function revalidatePath(path: string, type: RevalidateType): boolean {
  _activeInvalidationSet().add(type === "layout" ? `${path}:layout` : path);

  let deleted = false;
  const purgedPaths: string[] = [];
  for (const instance of allInstances()) {
    withInstance(instance, () => {
      for (const invalidator of getCacheInvalidators(instance)) {
        const result = invalidator.invalidatePath(path, type);
        deleted = result.deleted || deleted;
        purgedPaths.push(...result.purgedPaths);
      }
    });
  }

  callCachePurger(dedupePaths([...purgedPaths, path]));
  return deleted;
}

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

/** @internal — resets all module state between tests */
export function __resetCacheState(): void {
  for (const instance of allStateBuckets()) {
    isrRouteCache(instance).clear();
    ssgRouteCache(instance).clear();
    clearDevLoaderCaches(instance);
    instance.buildId = "";
  }
  // Forget mounted instances (fresh furin() calls between tests must not hit
  // prefix collisions) but keep the default bucket — cache slots above are
  // cleared, while process-wide defaults like a beforeAll template survive.
  __clearInstanceRegistry();
  _globalPendingInvalidations.clear();
  _cachePurger = null;
}
