export interface SyncChangePayload {
  cursor: string;
  invalidations: readonly string[];
}

export interface SyncChangePagePayload {
  changes: readonly SyncChangePayload[];
  cursor: string;
  hasMore: boolean;
  reset: boolean;
}

interface SyncCatchUpOptions {
  fetchPage: (after: string | undefined) => Promise<SyncChangePagePayload>;
  onInvalidations: (invalidations: readonly string[]) => void;
}

export interface SyncCatchUp {
  catchUp(): Promise<void>;
  cursor(): string | undefined;
  initialize(): Promise<void>;
}

interface InvalidationRefreshOptions {
  onError: (error: unknown) => void;
  refresh: () => Promise<void>;
}

export interface InvalidationRefresh {
  run(): Promise<void>;
}

export function createInvalidationRefresh(
  options: InvalidationRefreshOptions
): InvalidationRefresh {
  let running: Promise<void> | undefined;
  return {
    run() {
      if (!running) {
        running = options
          .refresh()
          .catch((error: unknown) => {
            if (!isAbortError(error)) {
              options.onError(error);
            }
          })
          .finally(() => {
            running = undefined;
          });
      }
      return running;
    },
  };
}

export function createSyncCatchUp(options: SyncCatchUpOptions): SyncCatchUp {
  let currentCursor: string | undefined;
  let running: Promise<void> | undefined;
  let requested = false;

  const readUntilCurrent = async (): Promise<void> => {
    do {
      requested = false;
      let page: SyncChangePagePayload;
      do {
        page = await options.fetchPage(currentCursor ?? "0");
        for (const change of page.changes) {
          options.onInvalidations(change.invalidations);
        }
        currentCursor = page.cursor;
      } while (page.hasMore);
    } while (requested);
  };

  return {
    async initialize() {
      const page = await options.fetchPage(undefined);
      currentCursor = page.cursor;
    },
    catchUp() {
      requested = true;
      if (!running) {
        running = readUntilCurrent().finally(() => {
          running = undefined;
        });
      }
      return running;
    },
    cursor: () => currentCursor,
  };
}

import { isAbortError } from "./abort.ts";
