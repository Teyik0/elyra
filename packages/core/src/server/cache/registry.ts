import type { Cache } from "./route-cache";

export type CacheInvalidator = Pick<Cache<unknown>, "invalidatePath" | "name">;

const _cacheInvalidators = new Map<string, CacheInvalidator>();

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

export function getCacheInvalidators(): IterableIterator<CacheInvalidator> {
  return _cacheInvalidators.values();
}

export function clearCacheInvalidators(): void {
  _cacheInvalidators.clear();
}
