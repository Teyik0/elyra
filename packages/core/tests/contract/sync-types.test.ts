// biome-ignore-all lint/suspicious/noUnusedExpressions: expect-type assertions are compile-time only

import { test } from "bun:test";
import { expectTypeOf } from "expect-type";
import type {
  PollingSyncNotifier,
  SyncNotifier,
  SyncRuntimeOptions,
} from "../../src/server/sync/index.ts";

type SyncModule = typeof import("../../src/server/sync/index.ts");
type FurinModule = typeof import("../../src/furin.ts");

test("sync entrypoints require an explicit runtime", () => {
  type StreamOptions = Parameters<SyncModule["createSyncStreamPlugin"]>[0];
  type PluginOptions = Parameters<SyncModule["furinSync"]>[0];
  type FurinOptions = NonNullable<Parameters<FurinModule["furin"]>[0]>;

  expectTypeOf<StreamOptions>().toExtend<SyncRuntimeOptions>();
  expectTypeOf<PluginOptions>().toEqualTypeOf<SyncRuntimeOptions>();
  expectTypeOf<Parameters<SyncModule["furinSync"]>>().toEqualTypeOf<
    [options: SyncRuntimeOptions]
  >();
  expectTypeOf<false>().toExtend<FurinOptions["sync"]>();
  expectTypeOf<true>().not.toExtend<FurinOptions["sync"]>();
});

test("public sync surface excludes memory implementations", () => {
  expectTypeOf<"MemorySyncAdapter">().not.toExtend<keyof SyncModule>();
  expectTypeOf<"MemorySyncNotifier">().not.toExtend<keyof SyncModule>();
});

test("public polling notifier remains usable as an instance type", () => {
  expectTypeOf<
    InstanceType<SyncModule["PollingSyncNotifier"]>
  >().toEqualTypeOf<PollingSyncNotifier>();
  expectTypeOf<PollingSyncNotifier>().toExtend<SyncNotifier>();
});
