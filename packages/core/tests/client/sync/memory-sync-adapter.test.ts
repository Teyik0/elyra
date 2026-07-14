import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { SyncInvalidation } from "../../../src/server/sync/adapter.ts";
import { MemorySyncAdapter } from "../../../src/server/sync/memory-adapter.ts";
import { testSyncAdapterConformance } from "../../helpers/sync-adapter-conformance";

const response = { body: new Uint8Array(), headers: [], status: 204 } as const;

afterEach(() => {
  setSystemTime();
});

describe("MemorySyncAdapter", () => {
  testSyncAdapterConformance(() => new MemorySyncAdapter());

  test("replays a response only for the same fingerprint", async () => {
    const adapter = new MemorySyncAdapter();
    const first = await adapter.beginMutation({
      fingerprint: "body",
      key: "mutation",
      principal: "user",
    });
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") {
      throw new Error("expected mutation lease");
    }

    expect(
      await adapter.completeMutation({ invalidations: [], lease: first.lease, response })
    ).toEqual({ cursor: undefined, kind: "committed" });
    expect(
      await adapter.beginMutation({ fingerprint: "body", key: "mutation", principal: "user" })
    ).toEqual({ kind: "replay", response });
    expect(
      await adapter.beginMutation({ fingerprint: "other", key: "mutation", principal: "user" })
    ).toEqual({ kind: "conflict", reason: "payload-mismatch" });
  });

  test("reuses an idempotency key with a new payload after completed retention expires", async () => {
    setSystemTime(new Date(1000));
    const adapter = new MemorySyncAdapter();
    const first = await adapter.beginMutation({
      fingerprint: "first-body",
      key: "mutation",
      principal: "user",
    });
    if (first.kind !== "execute") {
      throw new Error("expected mutation lease");
    }
    await adapter.completeMutation({ invalidations: [], lease: first.lease, response });

    setSystemTime(new Date(1000 + 24 * 60 * 60 * 1000 + 1));

    expect(
      await adapter.beginMutation({
        fingerprint: "second-body",
        key: "mutation",
        principal: "user",
      })
    ).toMatchObject({ kind: "execute" });
  });

  test("allows lease takeover and rejects the previous owner", async () => {
    setSystemTime(new Date(1000));
    const adapter = new MemorySyncAdapter();
    const first = await adapter.beginMutation({
      fingerprint: "body",
      key: "mutation",
      principal: "user",
    });
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") {
      throw new Error("expected first mutation lease");
    }

    setSystemTime(new Date(1000 + first.lease.leaseMs + 1));
    expect(
      await adapter.beginMutation({
        fingerprint: "other",
        key: "mutation",
        principal: "user",
      })
    ).toEqual({ kind: "conflict", reason: "payload-mismatch" });
    const second = await adapter.beginMutation({
      fingerprint: "body",
      key: "mutation",
      principal: "user",
    });
    expect(second.kind).toBe("execute");
    if (second.kind !== "execute") {
      throw new Error("expected replacement mutation lease");
    }

    expect(
      await adapter.completeMutation({ invalidations: [], lease: first.lease, response })
    ).toEqual({ kind: "lost" });
    expect(
      await adapter.completeMutation({ invalidations: [], lease: second.lease, response })
    ).toEqual({ cursor: undefined, kind: "committed" });
  });

  test("renews an active lease", async () => {
    setSystemTime(new Date(1000));
    const adapter = new MemorySyncAdapter();
    const first = await adapter.beginMutation({
      fingerprint: "body",
      key: "mutation",
      principal: "user",
    });
    if (first.kind !== "execute") {
      throw new Error("expected mutation lease");
    }

    setSystemTime(new Date(1000 + first.lease.leaseMs - 1));
    expect(await adapter.renewMutation(first.lease)).toBe("renewed");
    setSystemTime(new Date(1000 + first.lease.leaseMs + 1));
    expect(
      await adapter.completeMutation({ invalidations: [], lease: first.lease, response })
    ).toEqual({ cursor: undefined, kind: "committed" });
  });

  test("does not renew an expired lease", async () => {
    setSystemTime(new Date(1000));
    const adapter = new MemorySyncAdapter();
    const first = await adapter.beginMutation({
      fingerprint: "body",
      key: "mutation",
      principal: "user",
    });
    if (first.kind !== "execute") {
      throw new Error("expected mutation lease");
    }
    setSystemTime(new Date(1000 + first.lease.leaseMs + 1));
    expect(await adapter.renewMutation(first.lease)).toBe("lost");
  });

  test("snapshots invalidations when completing a mutation", async () => {
    const adapter = new MemorySyncAdapter();
    const tags = ["cards"];
    const invalidations: SyncInvalidation[] = [{ kind: "tags", tags }];
    const first = await adapter.beginMutation({
      fingerprint: "body",
      key: "mutation",
      principal: "user",
    });
    if (first.kind !== "execute") {
      throw new Error("expected mutation lease");
    }
    await adapter.completeMutation({ invalidations, lease: first.lease, response });

    tags.push("changed");
    invalidations.length = 0;

    expect((await adapter.readChanges({ after: "0", limit: 10 })).changes).toEqual([
      { cursor: "1", invalidations: [{ kind: "tags", tags: ["cards"] }] },
    ]);
  });

  test("does not expose stored invalidations through change reads", async () => {
    const adapter = new MemorySyncAdapter();
    const first = await adapter.beginMutation({
      fingerprint: "body",
      key: "mutation",
      principal: "user",
    });
    if (first.kind !== "execute") {
      throw new Error("expected mutation lease");
    }
    await adapter.completeMutation({
      invalidations: [{ kind: "tags", tags: ["cards"] }],
      lease: first.lease,
      response,
    });

    const firstRead = await adapter.readChanges({ after: "0", limit: 10 });
    const exposed = firstRead.changes[0]?.invalidations[0];
    if (exposed?.kind !== "tags") {
      throw new Error("expected tag invalidation");
    }
    (exposed.tags as string[]).push("changed");

    expect((await adapter.readChanges({ after: "0", limit: 10 })).changes).toEqual([
      { cursor: "1", invalidations: [{ kind: "tags", tags: ["cards"] }] },
    ]);
  });

  test("returns a reset for a cursor with trailing non-decimal syntax", async () => {
    const adapter = new MemorySyncAdapter();

    expect(await adapter.readChanges({ after: "0x1", limit: 10 })).toMatchObject({
      changes: [],
      reset: true,
    });
  });

  test("returns a reset when retained history no longer covers the cursor", async () => {
    const adapter = new MemorySyncAdapter();
    const results = await Promise.all(
      Array.from({ length: 1001 }, (_, index) =>
        adapter.beginMutation({
          fingerprint: `body-${index}`,
          key: `mutation-${index}`,
          principal: "user",
        })
      )
    );
    await Promise.all(
      results.map((result, index) => {
        if (result.kind !== "execute") {
          throw new Error("expected mutation lease");
        }
        return adapter.completeMutation({
          invalidations: [{ kind: "path", path: `/items/${index}`, type: "page" }],
          lease: result.lease,
          response,
        });
      })
    );

    expect(await adapter.readChanges({ after: "0", limit: 100 })).toMatchObject({
      changes: [],
      reset: true,
    });
  });
});
