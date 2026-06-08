import { createHtmlRouteCache, type SsgCacheEntry } from "./isr-ssg";

export const ssgRouteCache = createHtmlRouteCache<SsgCacheEntry>("ssg");

export const ssgCache = ssgRouteCache.store;

export function getSSGCache(key: string): SsgCacheEntry | undefined {
  return ssgRouteCache.get(key);
}

export function setSSGCache(key: string, entry: SsgCacheEntry): void {
  ssgRouteCache.set(key, entry);
}
