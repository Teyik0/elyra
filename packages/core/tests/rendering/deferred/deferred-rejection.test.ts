import { describe, expect, test } from "bun:test";
import { fromCrossJSON, toCrossJSON } from "seroval";
import "../../setup/evlog-mock";

import { serializeDeferredRejection } from "../../../src/server/render/loaders.ts";
import { isNotFoundError, notFound } from "../../../src/shared/not-found.ts";

async function roundtrip(value: unknown): Promise<unknown> {
  const normalized = await serializeDeferredRejection(value);
  const chunk = toCrossJSON(normalized);
  return fromCrossJSON(chunk, {});
}

describe("serializeDeferredRejection — preserves rejection semantics over CrossJSON", () => {
  test("notFound(): brand preserved so isNotFoundError() is true on the client", async () => {
    let thrown: unknown;
    try {
      notFound({ data: { id: "x" }, message: "missing" });
    } catch (e) {
      thrown = e;
    }

    const result = await roundtrip(thrown);

    expect(isNotFoundError(result)).toBe(true);
    expect((result as Error).message).toBe("missing");
    expect((result as { data?: { id?: string } }).data).toEqual({ id: "x" });
  });

  test("notFound() without options: brand preserved, empty message", async () => {
    let thrown: unknown;
    try {
      notFound(undefined);
    } catch (e) {
      thrown = e;
    }

    const result = await roundtrip(thrown);

    expect(isNotFoundError(result)).toBe(true);
  });

  test("Response(403, body): status and message preserved", async () => {
    const response = new Response("forbidden", { status: 403, statusText: "Forbidden" });

    const result = await roundtrip(response);

    expect((result as Error).message).toBe("forbidden");
    expect((result as { __furinStatus?: number }).__furinStatus).toBe(403);
    expect(isNotFoundError(result)).toBe(false);
  });

  test("Response without body: uses statusText", async () => {
    const response = new Response(null, { status: 401, statusText: "Unauthorized" });

    const result = await roundtrip(response);

    expect((result as Error).message).toBe("Unauthorized");
    expect((result as { __furinStatus?: number }).__furinStatus).toBe(401);
  });

  test("standard Error: message preserved as-is", async () => {
    const err = new Error("boom");

    const result = await roundtrip(err);

    expect((result as Error).message).toBe("boom");
    expect(isNotFoundError(result)).toBe(false);
  });

  test("throw non-Error (string): wrapped in Error", async () => {
    const result = await roundtrip("oops");

    expect((result as Error).message).toBe("oops");
  });
});
