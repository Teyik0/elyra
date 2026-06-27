import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createMutationFingerprint } from "../src/server/sync/fingerprint.ts";

afterEach(() => {
  spyOn(String.prototype, "localeCompare").mockRestore();
});

describe("createMutationFingerprint", () => {
  test("does not depend on the host locale for object or query ordering", async () => {
    spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("locale-sensitive comparison used");
    });

    await expect(
      createMutationFingerprint({
        body: { z: 1, a: 2 },
        request: new Request("http://localhost/cards?z=1&a=2", { method: "POST" }),
      })
    ).resolves.toBeString();
  });
});
