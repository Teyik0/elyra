// Map-like facade over a lazily-resolved backing store. Keeps the historical
// `ssgCache` / `isrCache` module exports working now that the real Map lives
// on the current furin instance (see server/instance.ts).
export interface StoreView<Entry> {
  clear(): void;
  delete(key: string): boolean;
  entries(): IterableIterator<[string, Entry]>;
  get(key: string): Entry | undefined;
  has(key: string): boolean;
  keys(): IterableIterator<string>;
  set(key: string, entry: Entry): void;
  readonly size: number;
}

export function createStoreView<Entry>(resolve: () => Map<string, Entry>): StoreView<Entry> {
  return {
    clear: () => resolve().clear(),
    delete: (key) => resolve().delete(key),
    entries: () => resolve().entries(),
    get: (key) => resolve().get(key),
    has: (key) => resolve().has(key),
    keys: () => resolve().keys(),
    set: (key, entry) => {
      resolve().set(key, entry);
    },
    get size() {
      return resolve().size;
    },
  };
}
