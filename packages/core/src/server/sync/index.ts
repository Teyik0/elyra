// biome-ignore-all lint/performance/noBarrelFile: sync has a small public/internal surface

import {
  getSyncStreamPath as getSyncStreamPathImplementation,
  resolveSyncStreamPath as resolveSyncStreamPathImplementation,
  runWithSyncStreamPath as runWithSyncStreamPathImplementation,
} from "./config.ts";
import { MemorySyncAdapter as MemorySyncAdapterImplementation } from "./memory-adapter.ts";
import {
  MemorySyncNotifier as MemorySyncNotifierImplementation,
  PollingSyncNotifier as PollingSyncNotifierImplementation,
} from "./notifier.ts";
import { furinSync as furinSyncImplementation } from "./plugin.ts";
import { createSyncStreamPlugin as createSyncStreamPluginImplementation } from "./stream.ts";

export const createSyncStreamPlugin = createSyncStreamPluginImplementation;
export const furinSync = furinSyncImplementation;
export const getSyncStreamPath = getSyncStreamPathImplementation;
export const MemorySyncAdapter = MemorySyncAdapterImplementation;
export const MemorySyncNotifier = MemorySyncNotifierImplementation;
export const PollingSyncNotifier = PollingSyncNotifierImplementation;
export const resolveSyncStreamPath = resolveSyncStreamPathImplementation;
export const runWithSyncStreamPath = runWithSyncStreamPathImplementation;

export type {
  BeginMutationInput,
  BeginMutationResult,
  ChangePage,
  CompleteMutationInput,
  CompleteMutationResult,
  MutationLease,
  ReadChangesInput,
  StoredResponse,
  SyncAdapter,
  SyncChange,
  SyncInvalidation,
  SyncNotifier,
  SyncRuntimeOptions,
  SyncSubscription,
} from "./adapter.ts";
export type { FurinSyncOption } from "./config.ts";
export type { SyncInput, SyncRouteOption } from "./plugin.ts";
export type { SyncChangePage } from "./stream.ts";
