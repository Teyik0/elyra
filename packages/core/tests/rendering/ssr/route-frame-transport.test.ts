import { expect, test } from "bun:test";
import { createDeferredRouteFrameStream } from "../../../src/server/render/route-frame-transport.ts";

test("deferred route frames reject a stream larger than the parser limit", async () => {
  const deferred = Object.fromEntries(
    Array.from({ length: 17 }, (_, index) => [
      `part-${index}`,
      Promise.resolve("x".repeat(512 * 1024)),
    ])
  );

  const response = new Response(createDeferredRouteFrameStream({}, deferred));

  await expect(response.arrayBuffer()).rejects.toThrow("route frame stream exceeds");
});
