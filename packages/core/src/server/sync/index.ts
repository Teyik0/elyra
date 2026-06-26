// biome-ignore-all lint/performance/noBarrelFile: sync has a small public/internal surface
export type { FurinSyncOption } from "./config.ts";
export { getSyncStreamPath, resolveSyncStreamPath, setSyncStreamPath } from "./config.ts";
export { furinSync, type SyncInput } from "./plugin.ts";
export {
  __resetSyncState,
  createSyncStreamPlugin,
  publishSyncInvalidation,
  type SyncInvalidationEvent,
} from "./stream.ts";
