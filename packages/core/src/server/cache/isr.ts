import { autoInvalidateRegistry } from "../auto-invalidate/registry";
import type { ISRCacheEntry } from "./isr-ssg";
import { createRouteCache } from "./route-cache";

/** Maximum number of ISR cache entries before LRU eviction kicks in. */
const MAX_ISR_CACHE_SIZE = 1000;

export const isrRouteCache = createRouteCache<ISRCacheEntry>({
  maxSize: MAX_ISR_CACHE_SIZE,
  name: "render:isr-html",
  onDelete: (key) => {
    autoInvalidateRegistry.unregisterPath(key);
  },
});

export const isrCache = isrRouteCache.store;

export function getISRCache(key: string): ISRCacheEntry | undefined {
  return isrRouteCache.get(key);
}

export function setISRCache(key: string, entry: ISRCacheEntry): void {
  isrRouteCache.set(key, entry);
}
