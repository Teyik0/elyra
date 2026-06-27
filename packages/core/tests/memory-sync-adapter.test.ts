import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { MemorySyncAdapter } from "../src/server/sync/memory-adapter.ts";

afterEach(() => {
  spyOn(Date, "now").mockRestore();
});

describe("MemorySyncAdapter", () => {
  test("expires abandoned in-progress mutations", () => {
    let now = 1000;
    spyOn(Date, "now").mockImplementation(() => now);
    const adapter = new MemorySyncAdapter();

    expect(
      adapter.beginMutation({ fingerprint: "body", key: "mutation", principal: "user" }).kind
    ).toBe("execute");
    now += 24 * 60 * 60 * 1000 + 1;

    expect(
      adapter.beginMutation({ fingerprint: "body", key: "mutation", principal: "user" }).kind
    ).toBe("execute");
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
});
