import { type FurinInstance, instanceSlot } from "../instance.ts";
import { createHtmlRouteCache, type ISRCacheEntry } from "./isr-ssg";
import { registerCacheInvalidator } from "./registry";
import type { Cache } from "./route-cache";
import { createStoreView, type StoreView } from "./store-view";

interface ISRCacheState {
  cache: Cache<ISRCacheEntry>;
  generations: Map<string, number>;
  pendingRevalidations: Map<string, Promise<void>>;
}

// Per-instance ISR HTML cache — registered against the owning instance's
// invalidator map on first access.
const instanceIsrCache = instanceSlot<ISRCacheState>((instance) => {
  const generations = new Map<string, number>();
  const pendingRevalidations = new Map<string, Promise<void>>();
  const cache = createHtmlRouteCache<ISRCacheEntry>("isr", {
    onDelete: (key) => {
      generations.set(key, (generations.get(key) ?? 0) + 1);
    },
  });
  registerCacheInvalidator(cache, instance);
  return { cache, generations, pendingRevalidations };
});

export function isrRouteCache(instance?: FurinInstance): Cache<ISRCacheEntry> {
  return instanceIsrCache(instance).cache;
}

/** Raw store view over the current instance's ISR cache. */
export const isrCache: StoreView<ISRCacheEntry> = createStoreView(
  () => instanceIsrCache().cache.store
);

export function getISRCache(key: string): ISRCacheEntry | undefined {
  return instanceIsrCache().cache.get(key);
}

export function deleteISRCache(key: string): boolean {
  return instanceIsrCache().cache.delete(key);
}

export function setISRCache(key: string, entry: ISRCacheEntry): void {
  instanceIsrCache().cache.set(key, entry);
}

export function captureISRCacheGeneration(key: string): number {
  return instanceIsrCache().generations.get(key) ?? 0;
}

export function setISRCacheIfGenerationUnchanged(
  key: string,
  entry: ISRCacheEntry,
  generation: number
): boolean {
  const state = instanceIsrCache();
  if ((state.generations.get(key) ?? 0) !== generation) {
    return false;
  }
  state.cache.set(key, entry);
  return true;
}

export function pendingISRRevalidations(): Map<string, Promise<void>> {
  return instanceIsrCache().pendingRevalidations;
}

export function clearPendingISRRevalidations(instance?: FurinInstance): void {
  instanceIsrCache(instance).pendingRevalidations.clear();
}

export async function waitForPendingISRRevalidations(): Promise<void> {
  await Promise.allSettled(instanceIsrCache().pendingRevalidations.values());
  await Bun.sleep(1);
}
