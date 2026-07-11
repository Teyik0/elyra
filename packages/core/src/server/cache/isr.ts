import { type FurinInstance, instanceSlot } from "../instance.ts";
import { createHtmlRouteCache, type ISRCacheEntry } from "./isr-ssg";
import { registerCacheInvalidator } from "./registry";
import type { Cache } from "./route-cache";
import { createStoreView, type StoreView } from "./store-view";

// Per-instance ISR HTML cache — registered against the owning instance's
// invalidator map on first access.
const instanceIsrCache = instanceSlot((instance) => {
  const cache = createHtmlRouteCache<ISRCacheEntry>("isr");
  registerCacheInvalidator(cache, instance);
  return cache;
});

export function isrRouteCache(instance?: FurinInstance): Cache<ISRCacheEntry> {
  return instanceIsrCache(instance);
}

/** Raw store view over the current instance's ISR cache. */
export const isrCache: StoreView<ISRCacheEntry> = createStoreView(() => instanceIsrCache().store);

export function getISRCache(key: string): ISRCacheEntry | undefined {
  return instanceIsrCache().get(key);
}

export function deleteISRCache(key: string): boolean {
  return instanceIsrCache().delete(key);
}

export function setISRCache(key: string, entry: ISRCacheEntry): void {
  instanceIsrCache().set(key, entry);
}
