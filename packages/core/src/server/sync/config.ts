import { AsyncLocalStorage } from "node:async_hooks";
import { currentInstance } from "../instance.ts";
import type { SyncRuntimeOptions } from "./adapter.ts";

const SYNC_STREAM_DEFAULT_PATH = "/_furin/sync";

// Explicit override scope (tests, synthetic renders). When unset, the sync
// stream path comes from the current furin instance.
const requestSyncStreamPath = new AsyncLocalStorage<string | undefined>();

export interface FurinSyncOptions extends SyncRuntimeOptions {
  streamPath?: string;
}

export type FurinSyncOption = FurinSyncOptions | false;

export function resolveSyncStreamPath(sync: FurinSyncOption | undefined): string | undefined {
  if (!sync) {
    return;
  }
  return sync.streamPath ?? SYNC_STREAM_DEFAULT_PATH;
}

/**
 * Logical (unprefixed) sync stream path for the current request — injected
 * into rendered HTML; the client prepends its own basePath before connecting.
 */
export function getSyncStreamPath(): string | undefined {
  const override = requestSyncStreamPath.getStore();
  if (override !== undefined) {
    return override;
  }
  return currentInstance().syncStreamPath;
}

export function runWithSyncStreamPath<T>(path: string | undefined, fn: () => T): T {
  return requestSyncStreamPath.run(path, fn);
}

export function syncRuntimeOptions(sync: FurinSyncOptions): SyncRuntimeOptions {
  return { adapter: sync.adapter, notifier: sync.notifier };
}
