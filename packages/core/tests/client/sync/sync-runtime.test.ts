import { afterEach, describe, expect, test } from "bun:test";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env";
import type { SyncAdapter } from "../../../src/server/sync/adapter";
import { resolveSyncStreamPath, syncRuntimeOptions } from "../../../src/server/sync/config";
import { MemorySyncAdapter } from "../../../src/server/sync/memory-adapter";
import { PollingSyncNotifier } from "../../../src/server/sync/notifier";
import { resolveSyncRuntime } from "../../../src/server/sync/runtime";

const originalDevMode = IS_DEV;

afterEach(() => {
  __setDevMode(originalDevMode);
});

function distributedAdapter(currentCursor: () => Promise<string>): SyncAdapter {
  return {
    scope: "distributed",
    abortMutation: async () => undefined,
    beginMutation: async () => ({ kind: "unavailable" }),
    completeMutation: async () => ({ kind: "lost" }),
    currentCursor,
    readChanges: async () => ({ changes: [], cursor: "0", hasMore: false, reset: false }),
    renewMutation: async () => "lost",
  };
}

describe("sync runtime", () => {
  test("keeps the legacy streamPath-only development configuration", () => {
    const sync = { streamPath: "/events" };
    expect(resolveSyncStreamPath(sync)).toBe("/events");
    expect(syncRuntimeOptions(sync)).toBeUndefined();
  });

  test("rejects implicit and process-local storage in production", () => {
    __setDevMode(false);
    expect(() => resolveSyncRuntime(undefined)).toThrow("explicit distributed SyncAdapter");
    expect(() => resolveSyncRuntime({ adapter: new MemorySyncAdapter() })).toThrow(
      "process-local SyncAdapter"
    );
  });

  test("uses currentCursor polling when a distributed adapter has no notifier", async () => {
    __setDevMode(false);
    let cursor = "0";
    const runtime = resolveSyncRuntime({
      adapter: distributedAdapter(async () => cursor),
    });
    expect(runtime.notifier).toBeInstanceOf(PollingSyncNotifier);
    let receiveCursor: (nextCursor: string) => void = () => {
      throw new Error("Polling resolved before the test was ready");
    };
    const received = new Promise<string>((resolve) => {
      receiveCursor = resolve;
    });
    const subscription = await runtime.notifier.subscribe(receiveCursor);
    cursor = "1";
    expect(await received).toBe("1");
    await subscription.unsubscribe();
  });
});
