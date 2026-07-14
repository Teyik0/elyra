// biome-ignore-all lint/suspicious/noUnusedExpressions: expect-type assertions are compile-time only

import { test } from "bun:test";
import { expectTypeOf } from "expect-type";
import type {
  MemorySyncAdapter,
  MemorySyncNotifier,
  PollingSyncNotifier,
  SyncAdapter,
  SyncNotifier,
} from "../../src/server/sync/index.ts";

type SyncModule = typeof import("../../src/server/sync/index.ts");

test("sync stream runtime configuration rejects obsolete string channels", () => {
  type RuntimeOptions = Parameters<SyncModule["createSyncStreamPlugin"]>[1];

  expectTypeOf<RuntimeOptions>().not.toExtend<string>();
});

test("public sync classes remain usable as instance types", () => {
  expectTypeOf<InstanceType<SyncModule["MemorySyncAdapter"]>>().toEqualTypeOf<MemorySyncAdapter>();
  expectTypeOf<MemorySyncAdapter>().toExtend<SyncAdapter>();
  expectTypeOf<
    InstanceType<SyncModule["MemorySyncNotifier"]>
  >().toEqualTypeOf<MemorySyncNotifier>();
  expectTypeOf<MemorySyncNotifier>().toExtend<SyncNotifier>();
  expectTypeOf<
    InstanceType<SyncModule["PollingSyncNotifier"]>
  >().toEqualTypeOf<PollingSyncNotifier>();
  expectTypeOf<PollingSyncNotifier>().toExtend<SyncNotifier>();
});
