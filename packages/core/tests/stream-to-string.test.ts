import { describe, expect, test } from "bun:test";
import { streamToString } from "../src/server/render/index.ts";

describe("streamToString", () => {
  test("converts readable stream to string", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("Hello "));
        controller.enqueue(encoder.encode("World"));
        controller.close();
      },
    });

    const result = await streamToString(stream);
    expect(result).toBe("Hello World");
  });

  test("handles empty stream", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    const result = await streamToString(stream);
    expect(result).toBe("");
  });

  test("handles multi-byte characters", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("Hello "));
        controller.enqueue(encoder.encode("世界"));
        controller.close();
      },
    });

    const result = await streamToString(stream);
    expect(result).toBe("Hello 世界");
  });
});
