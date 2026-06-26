const SYNC_STREAM_DEFAULT_PATH = "/_furin/sync";

let _syncStreamPath: string | undefined;

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

export function setSyncStreamPath(path: string | undefined): void {
  _syncStreamPath = path;
}

export function getSyncStreamPath(): string | undefined {
  return _syncStreamPath;
}
