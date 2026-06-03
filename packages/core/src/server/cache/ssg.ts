import { autoInvalidateRegistry } from "../auto-invalidate/registry";
import type { SsgCacheEntry } from "./isr-ssg";
import { createRouteCache } from "./route-cache";

/** Maximum number of SSG cache entries before LRU eviction kicks in. */
const MAX_SSG_CACHE_SIZE = 1000;

export const ssgRouteCache = createRouteCache<SsgCacheEntry>({
  maxSize: MAX_SSG_CACHE_SIZE,
  name: "render:ssg-html",
  onDelete: (key) => {
    autoInvalidateRegistry.unregisterPath(key);
  },
});

export const ssgCache = ssgRouteCache.store;

export function getSSGCache(key: string): SsgCacheEntry | undefined {
  return ssgRouteCache.get(key);
}

export function setSSGCache(key: string, entry: SsgCacheEntry): void {
  ssgRouteCache.set(key, entry);
}
