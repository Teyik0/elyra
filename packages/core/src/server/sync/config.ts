import { AsyncLocalStorage } from "node:async_hooks";

const SYNC_STREAM_DEFAULT_PATH = "/_furin/sync";

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

export function getSyncStreamPath(): string | undefined {
  return requestSyncStreamPath.getStore();
}

export function runWithSyncStreamPath<T>(path: string | undefined, fn: () => T): T {
  return requestSyncStreamPath.run(path, fn);
}
