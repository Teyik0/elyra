import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { MemorySyncAdapter } from "../../../src/server/sync/memory-adapter.ts";

interface MemorySyncAdapterStoreView {
  readonly mutations: ReadonlyMap<string, { readonly createdAt: number }>;
}

function mutationCount(adapter: MemorySyncAdapter): number {
  return (adapter as unknown as MemorySyncAdapterStoreView).mutations.size;
}

afterEach(() => {
  setSystemTime();
});

describe("MemorySyncAdapter", () => {
  test("expires abandoned in-progress mutations", () => {
    const now = 1000;
    setSystemTime(new Date(now));
    const adapter = new MemorySyncAdapter();

    expect(
      adapter.beginMutation({ fingerprint: "body", key: "mutation", principal: "user" }).kind
    ).toBe("execute");
    setSystemTime(new Date(now + 24 * 60 * 60 * 1000 + 1));

    expect(
      adapter.beginMutation({ fingerprint: "body", key: "mutation", principal: "user" }).kind
    ).toBe("execute");
  });

  test("expires old completed mutations during ordinary mutation traffic", () => {
    const now = 1000;
    setSystemTime(new Date(now));
    const adapter = new MemorySyncAdapter();
    const first = adapter.beginMutation({
      fingerprint: "body",
      key: "mutation-0",
      principal: "user",
    });

    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") {
      throw new Error("expected first mutation to execute");
    }
    adapter.commitMutation({
      mutationId: first.mutationId,
      response: { body: new Uint8Array(), headers: [], status: 204 },
    });

    setSystemTime(new Date(now + 24 * 60 * 60 * 1000 + 1));
    expect(
      adapter.beginMutation({ fingerprint: "body", key: "mutation-1", principal: "user" }).kind
    ).toBe("execute");

    expect(mutationCount(adapter)).toBe(1);
  });

  test("rejects new mutations when only active entries fill the capacity", () => {
    const adapter = new MemorySyncAdapter();
    for (let index = 0; index < 10_000; index += 1) {
      adapter.beginMutation({ fingerprint: "body", key: `mutation-${index}`, principal: "user" });
    }

    expect(
      adapter.beginMutation({ fingerprint: "body", key: "overflow", principal: "user" }).kind
    ).toBe("unavailable");
  });

  test("evicts completed mutations when capacity is full", () => {
    const adapter = new MemorySyncAdapter();
    const first = adapter.beginMutation({
      fingerprint: "body",
      key: "mutation-0",
      principal: "user",
    });

    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") {
      throw new Error("expected first mutation to execute");
    }
    adapter.commitMutation({
      mutationId: first.mutationId,
      response: { body: new Uint8Array(), headers: [], status: 204 },
    });

    for (let index = 1; index < 10_000; index += 1) {
      adapter.beginMutation({ fingerprint: "body", key: `mutation-${index}`, principal: "user" });
    }

    expect(
      adapter.beginMutation({ fingerprint: "body", key: "overflow", principal: "user" }).kind
    ).toBe("execute");
  });
});
