import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createMutationFingerprint } from "../../../src/server/sync/fingerprint.ts";

afterEach(() => {
  spyOn(String.prototype, "localeCompare").mockRestore();
});

describe("createMutationFingerprint", () => {
  test("does not depend on the host locale for object or query ordering", async () => {
    spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("locale-sensitive comparison used");
    });

    const [first, second] = await Promise.all([
      createMutationFingerprint({
        body: { a: 2, z: 1 },
        request: new Request("http://localhost/cards?z=1&a=2", { method: "POST" }),
      }),
      createMutationFingerprint({
        body: { a: 2, z: 1 },
        request: new Request("http://localhost/cards?a=2&z=1", { method: "POST" }),
      }),
    ]);

    expect(first).toBe(second);
  });
});
