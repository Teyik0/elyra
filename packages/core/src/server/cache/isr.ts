import { createHtmlRouteCache, type ISRCacheEntry } from "./isr-ssg";

export const isrRouteCache = createHtmlRouteCache<ISRCacheEntry>("isr");

export const isrCache = isrRouteCache.store;

export function getISRCache(key: string): ISRCacheEntry | undefined {
  return isrRouteCache.get(key);
}

export function deleteISRCache(key: string): boolean {
  return isrRouteCache.delete(key);
}

export function setISRCache(key: string, entry: ISRCacheEntry): void {
  isrRouteCache.set(key, entry);
}
