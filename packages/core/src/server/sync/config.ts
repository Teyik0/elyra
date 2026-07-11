import { AsyncLocalStorage } from "node:async_hooks";
import { allInstances, currentInstance } from "../instance.ts";

const SYNC_STREAM_DEFAULT_PATH = "/_furin/sync";

// Explicit override scope (tests, synthetic renders). When unset, the sync
// stream path comes from the current furin instance.
const requestSyncStreamPath = new AsyncLocalStorage<string | undefined>();

export type FurinSyncOption =
  | boolean
  | {
      streamPath?: string;
    };

export function resolveSyncStreamPath(sync: FurinSyncOption | undefined): string | undefined {
  if (!sync) {
    return;
  }
  if (sync === true) {
    return SYNC_STREAM_DEFAULT_PATH;
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

/**
 * Physical adapter channels a sync publication must reach. An explicit
 * override wins (historical single-channel behaviour); otherwise every
 * sync-enabled instance gets notified — a mutation on a shared API must wake
 * the SSE clients of every mounted app.
 */
export function syncPublishChannels(): string[] {
  const override = requestSyncStreamPath.getStore();
  if (override !== undefined) {
    return [override];
  }
  const channels = allInstances()
    .filter((instance) => instance.syncStreamPath !== undefined)
    .map((instance) => `${instance.prefix}${instance.syncStreamPath}`);
  if (channels.length > 0) {
    return channels;
  }
  return [SYNC_STREAM_DEFAULT_PATH];
}
