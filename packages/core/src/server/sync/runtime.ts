import { IS_DEV } from "../runtime-env.ts";
import type { SyncAdapter, SyncNotifier, SyncRuntimeOptions } from "./adapter.ts";
import { memorySyncAdapter } from "./memory-adapter.ts";
import { memorySyncNotifier, PollingSyncNotifier } from "./notifier.ts";

const POLL_INTERVAL_MS = 250;
const pollingNotifiers = new WeakMap<object, PollingSyncNotifier>();

export interface ResolvedSyncRuntime {
  adapter: SyncAdapter;
  notifier: SyncNotifier;
}

export function resolveSyncRuntime(options: SyncRuntimeOptions | undefined): ResolvedSyncRuntime {
  if (!options) {
    if (!IS_DEV) {
      throw new Error("[furin] Production sync requires an explicit distributed SyncAdapter.");
    }
    return { adapter: memorySyncAdapter, notifier: memorySyncNotifier };
  }
  if (!IS_DEV && options.adapter.scope !== "distributed") {
    throw new Error("[furin] Production sync cannot use a process-local SyncAdapter.");
  }
  if (options.notifier) {
    return { adapter: options.adapter, notifier: options.notifier };
  }
  const existing = pollingNotifiers.get(options.adapter);
  if (existing) {
    return { adapter: options.adapter, notifier: existing };
  }
  const notifier = new PollingSyncNotifier(options.adapter, POLL_INTERVAL_MS);
  pollingNotifiers.set(options.adapter, notifier);
  return { adapter: options.adapter, notifier };
}
