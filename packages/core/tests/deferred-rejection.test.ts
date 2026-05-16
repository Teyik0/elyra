import { describe, expect, mock, test } from "bun:test";
import { fromCrossJSON, toCrossJSON } from "seroval";

// Stub evlog so render/* can import without a live request scope.
mock.module("evlog/elysia", () => ({
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
  useLogger: () => ({ set() {} }),
  evlog: () => (app: unknown) => app,
}));
mock.module("evlog", () => ({
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stubs
  log: { warn: () => {}, error: () => {}, info: () => {}, set: () => {} },
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stubs
  createLogger: () => ({ set() {}, error() {}, emit() {}, info() {}, warn() {} }),
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
  useLogger: () => ({ set() {} }),
}));

import { isNotFoundError, notFound } from "../src/not-found";
import { serializeDeferredRejection } from "../src/render/loaders";

async function roundtrip(value: unknown): Promise<unknown> {
  const normalized = await serializeDeferredRejection(value);
  const chunk = toCrossJSON(normalized);
  return fromCrossJSON(chunk, {});
}

describe("serializeDeferredRejection — preserves rejection semantics over CrossJSON", () => {
  test("notFound() : brand préservé pour que isNotFoundError() soit vrai côté client", async () => {
    let thrown: unknown;
    try {
      notFound({ message: "missing", data: { id: "x" } });
    } catch (e) {
      thrown = e;
    }

    const result = await roundtrip(thrown);

    expect(isNotFoundError(result)).toBe(true);
    expect((result as Error).message).toBe("missing");
    expect((result as { data?: { id?: string } }).data).toEqual({ id: "x" });
  });

  test("notFound() sans options : brand préservé, message vide", async () => {
    let thrown: unknown;
    try {
      notFound(undefined);
    } catch (e) {
      thrown = e;
    }

    const result = await roundtrip(thrown);

    expect(isNotFoundError(result)).toBe(true);
  });

  test("Response(403, body) : status et message préservés", async () => {
    const response = new Response("forbidden", { status: 403, statusText: "Forbidden" });

    const result = await roundtrip(response);

    expect((result as Error).message).toBe("forbidden");
    expect((result as { __furinStatus?: number }).__furinStatus).toBe(403);
    expect(isNotFoundError(result)).toBe(false);
  });

  test("Response sans body : utilise statusText", async () => {
    const response = new Response(null, { status: 401, statusText: "Unauthorized" });

    const result = await roundtrip(response);

    expect((result as Error).message).toBe("Unauthorized");
    expect((result as { __furinStatus?: number }).__furinStatus).toBe(401);
  });

  test("Error standard : message préservé tel quel", async () => {
    const err = new Error("boom");

    const result = await roundtrip(err);

    expect((result as Error).message).toBe("boom");
    expect(isNotFoundError(result)).toBe(false);
  });

  test("throw non-Error (string) : enveloppé dans Error", async () => {
    const result = await roundtrip("oops");

    expect((result as Error).message).toBe("oops");
  });
});
