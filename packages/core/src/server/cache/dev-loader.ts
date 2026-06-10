import { statSync } from "node:fs";
import { autoInvalidateRegistry } from "../auto-invalidate/registry";
import { registerCacheInvalidator } from "./registry";
import { createRouteCache, type RevalidateType } from "./route-cache";

export interface DevLoaderCacheEntry {
  dependencies: string[];
  generatedAt: number;
  headers: Record<string, string>;
  loaderData: Record<string, unknown>;
  mode: "isr" | "ssg";
  revalidate: number;
}

export interface InvalidateOutcome {
  cleared: string[];
  isr: number;
  ssg: number;
}

const sourceFileToCacheKeys = new Map<string, Set<string>>();

interface CacheKindHandle {
  cache: ReturnType<typeof createDevLoaderCache>;
  kind: "isr" | "ssg";
}

function indexEntryDependencies(cacheKey: string, deps: string[]): void {
  for (const dep of deps) {
    let bucket = sourceFileToCacheKeys.get(dep);
    if (!bucket) {
      bucket = new Set<string>();
      sourceFileToCacheKeys.set(dep, bucket);
    }
    bucket.add(cacheKey);
  }
}

function unindexEntryDependencies(cacheKey: string, deps: string[]): void {
  for (const dep of deps) {
    const bucket = sourceFileToCacheKeys.get(dep);
    if (!bucket) {
      continue;
    }
    bucket.delete(cacheKey);
    if (bucket.size === 0) {
      sourceFileToCacheKeys.delete(dep);
    }
  }
}

function createDevLoaderCache(name: string) {
  return createRouteCache<DevLoaderCacheEntry>({
    name,
    onDelete: (key, entry) => {
      unindexEntryDependencies(key, entry.dependencies);
      const urlPath = urlPathFromCacheKey(key);
      if (urlPath) {
        autoInvalidateRegistry.unregisterPath(urlPath);
      }
    },
    onSet: (key, entry, previous) => {
      if (previous) {
        unindexEntryDependencies(key, previous.dependencies);
      }
      indexEntryDependencies(key, entry.dependencies);
    },
    pathFromKey: urlPathFromCacheKey,
  });
}

export const devISRLoaderCache = createDevLoaderCache("render:dev-isr-loader");
export const devSSGLoaderCache = createDevLoaderCache("render:dev-ssg-loader");

const isrHandle: CacheKindHandle = { cache: devISRLoaderCache, kind: "isr" };
const ssgHandle: CacheKindHandle = { cache: devSSGLoaderCache, kind: "ssg" };

function setEntry(handle: CacheKindHandle, key: string, entry: DevLoaderCacheEntry): void {
  handle.cache.set(key, entry);
}

export function getDevISRLoaderCache(key: string): DevLoaderCacheEntry | undefined {
  return devISRLoaderCache.get(key);
}

export function setDevISRLoaderCache(key: string, entry: DevLoaderCacheEntry): void {
  setEntry(isrHandle, key, entry);
}

export function getDevSSGLoaderCache(key: string): DevLoaderCacheEntry | undefined {
  return devSSGLoaderCache.get(key);
}

export function setDevSSGLoaderCache(key: string, entry: DevLoaderCacheEntry): void {
  setEntry(ssgHandle, key, entry);
}

export function urlPathFromCacheKey(key: string): string | null {
  const sep = key.lastIndexOf(":/");
  if (sep === -1) {
    return null;
  }
  return key.slice(sep + 1);
}

export function invalidateDevLoaderCacheByPath(
  path: string,
  type: RevalidateType
): InvalidateOutcome {
  const cleared: string[] = [];
  let isr = 0;
  let ssg = 0;

  const matches = (urlPath: string): boolean => {
    if (type === "page") {
      return urlPath === path;
    }
    const prefix = path === "/" || path.endsWith("/") ? path : `${path}/`;
    return urlPath === path || urlPath.startsWith(prefix);
  };

  for (const handle of [isrHandle, ssgHandle]) {
    for (const key of [...handle.cache.keys()]) {
      const urlPath = urlPathFromCacheKey(key);
      if (urlPath === null || !matches(urlPath)) {
        continue;
      }
      const entry = handle.cache.get(key);
      if (!entry) {
        continue;
      }
      handle.cache.delete(key);
      cleared.push(key);
      if (handle.kind === "isr") {
        isr++;
      } else {
        ssg++;
      }
    }
  }

  return { cleared, isr, ssg };
}

export function invalidateDevLoaderCacheBySource(filePath: string): InvalidateOutcome {
  const keys = sourceFileToCacheKeys.get(filePath);
  if (!keys || keys.size === 0) {
    return { cleared: [], isr: 0, ssg: 0 };
  }

  const cleared: string[] = [];
  let isr = 0;
  let ssg = 0;

  const snapshot = [...keys];
  for (const key of snapshot) {
    const isrEntry = devISRLoaderCache.get(key);
    if (isrEntry) {
      devISRLoaderCache.delete(key);
      cleared.push(key);
      isr++;
      continue;
    }
    const ssgEntry = devSSGLoaderCache.get(key);
    if (ssgEntry) {
      devSSGLoaderCache.delete(key);
      cleared.push(key);
      ssg++;
    }
  }

  return { cleared, isr, ssg };
}

export function isDevLoaderCacheFresh(entry: DevLoaderCacheEntry): boolean {
  return Date.now() - entry.generatedAt < entry.revalidate * 1000;
}

export function isDevLoaderCacheValid(entry: DevLoaderCacheEntry): boolean {
  if (!isDevLoaderCacheFresh(entry)) {
    return false;
  }
  for (const dep of entry.dependencies) {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(dep).mtimeMs;
    } catch {
      return false;
    }
    if (mtimeMs > entry.generatedAt) {
      return false;
    }
  }
  return true;
}

export function getAllDevISRLoaderEntries(): [string, DevLoaderCacheEntry][] {
  return [...devISRLoaderCache.entries()];
}

export function getAllDevSSGLoaderEntries(): [string, DevLoaderCacheEntry][] {
  return [...devSSGLoaderCache.entries()];
}

export function __resetDevLoaderCacheState(): void {
  devISRLoaderCache.clear();
  devSSGLoaderCache.clear();
  sourceFileToCacheKeys.clear();
  registerCacheInvalidator(devISRLoaderCache);
  registerCacheInvalidator(devSSGLoaderCache);
}
