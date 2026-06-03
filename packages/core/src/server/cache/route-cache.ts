export type RevalidateType = "page" | "layout";

export interface CacheInvalidationResult {
  deleted: boolean;
  purgedPaths: string[];
}

export interface Cache<Entry> {
  clear(): void;
  delete(key: string): boolean;
  entries(): IterableIterator<[string, Entry]>;
  get(key: string): Entry | undefined;
  has(key: string): boolean;
  invalidatePath(path: string, type: RevalidateType): CacheInvalidationResult;
  keys(): IterableIterator<string>;
  readonly name: string;
  set(key: string, entry: Entry): void;
  get size(): number;
  readonly store: Map<string, Entry>;
}

export interface RouteCacheOptions<Entry> {
  maxSize?: number;
  name: string;
  onDelete?: (key: string, entry: Entry) => void;
  onSet?: (key: string, entry: Entry, previous: Entry | undefined) => void;
  pathFromKey?: (key: string) => string | null;
}

function defaultPathFromKey(key: string): string {
  return key;
}

function matchesPath(urlPath: string, path: string, type: RevalidateType): boolean {
  if (type === "page") {
    return urlPath === path;
  }
  const prefix = path === "/" || path.endsWith("/") ? path : `${path}/`;
  return urlPath === path || urlPath.startsWith(prefix);
}

export function createRouteCache<Entry>(options: RouteCacheOptions<Entry>): Cache<Entry> {
  const store = new Map<string, Entry>();
  const pathFromKey = options.pathFromKey ?? defaultPathFromKey;

  const evictOldest = (): void => {
    if (options.maxSize === undefined || store.size <= options.maxSize) {
      return;
    }
    const oldest = store.keys().next().value;
    if (oldest !== undefined) {
      deleteEntry(oldest);
    }
  };

  const deleteEntry = (key: string): boolean => {
    const entry = store.get(key);
    if (entry === undefined) {
      return false;
    }
    store.delete(key);
    options.onDelete?.(key, entry);
    return true;
  };

  return {
    name: options.name,
    store,
    get size() {
      return store.size;
    },
    get(key) {
      const entry = store.get(key);
      if (entry !== undefined && options.maxSize !== undefined) {
        store.delete(key);
        store.set(key, entry);
      }
      return entry;
    },
    set(key, entry) {
      const previous = store.get(key);
      if (previous !== undefined) {
        store.delete(key);
      }
      store.set(key, entry);
      options.onSet?.(key, entry, previous);
      evictOldest();
    },
    delete(key) {
      return deleteEntry(key);
    },
    clear() {
      for (const key of [...store.keys()]) {
        deleteEntry(key);
      }
      store.clear();
    },
    has(key) {
      return store.has(key);
    },
    entries() {
      return store.entries();
    },
    keys() {
      return store.keys();
    },
    invalidatePath(path, type) {
      let deleted = false;
      const purgedPaths: string[] = [];

      for (const key of [...store.keys()]) {
        const urlPath = pathFromKey(key);
        if (urlPath === null || !matchesPath(urlPath, path, type)) {
          continue;
        }
        deleteEntry(key);
        deleted = true;
        purgedPaths.push(urlPath);
      }

      return { deleted, purgedPaths: [...new Set(purgedPaths)] };
    },
  };
}
