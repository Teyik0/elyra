export interface StoredResponse {
  body: Uint8Array;
  headers: ReadonlyArray<readonly [string, string]>;
  status: number;
}

export interface BeginMutationInput {
  fingerprint: string;
  key: string;
}

export type BeginMutationResult =
  | { kind: "execute"; mutationId: string }
  | { kind: "replay"; response: StoredResponse }
  | { kind: "conflict"; reason: "in-progress" | "payload-mismatch" };

export interface CommitMutationInput {
  mutationId: string;
  response: StoredResponse;
}

export interface AbortMutationInput {
  mutationId: string;
}

export interface SyncChange {
  cursor: string;
  invalidations: readonly string[];
}

export interface AppendChangesInput {
  invalidations: readonly string[];
  path: string;
}

export interface AppendChangesResult {
  change: SyncChange;
}

export interface ReadChangesInput {
  after: string | undefined;
  limit: number;
  path: string;
}

export interface ChangePage {
  changes: readonly SyncChange[];
  cursor: string;
  hasMore: boolean;
  reset: boolean;
}

export type SyncChangeListener = (change: SyncChange) => void;
type MaybePromise<T> = Promise<T> | T;

export interface SyncAdapter {
  abortMutation(input: AbortMutationInput): MaybePromise<void>;
  appendChanges(input: AppendChangesInput): MaybePromise<AppendChangesResult>;
  beginMutation(input: BeginMutationInput): MaybePromise<BeginMutationResult>;
  commitMutation(input: CommitMutationInput): MaybePromise<void>;
  readChanges(input: ReadChangesInput): MaybePromise<ChangePage>;
  subscribe(path: string, listener: SyncChangeListener): () => void;
}
