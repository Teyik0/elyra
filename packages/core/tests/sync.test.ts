import { afterEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { furinSync } from "../src/furin.ts";
import { __resetCacheState, _runWithRequestInvalidationScope } from "../src/server/cache/index.ts";
import { injectSyncRuntimeScript } from "../src/server/render/assemble.ts";
import { runWithSyncStreamPath } from "../src/server/sync/config.ts";
import { __resetSyncState, createSyncStreamPlugin } from "../src/server/sync/stream.ts";

async function readNextChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error("Timed out waiting for sync event")), 1000);
  });
  const read = reader.read().then(({ value }) => {
    if (!value) {
      return "";
    }
    return new TextDecoder().decode(value);
  });

  return await Promise.race([read, timeout]);
}

afterEach(() => {
  __resetCacheState();
  __resetSyncState();
});

describe("furinSync macro", () => {
  test("sync mutation requires an idempotency key", async () => {
    let called = false;
    const app = new Elysia().use(furinSync()).patch(
      "/cards/:cardId",
      () => {
        called = true;
        return { ok: true };
      },
      {
        sync: { invalidate: { path: "/board", type: "layout" } },
      }
    );

    const response = await _runWithRequestInvalidationScope(() =>
      app.handle(new Request("http://localhost/cards/1", { method: "PATCH" }))
    );

    expect(response.status).toBe(428);
    expect(called).toBe(false);
    expect(response.headers.get("x-furin-revalidate")).toBeNull();
  });

  test("successful sync mutation emits revalidation headers and an SSE invalidation event", async () => {
    const app = new Elysia()
      .use(createSyncStreamPlugin())
      .use(furinSync())
      .patch("/cards/:cardId", () => ({ id: "card-1", title: "Renamed" }), {
        sync: { invalidate: { path: "/board", type: "layout" } },
      });

    const streamResponse = await app.handle(new Request("http://localhost/_furin/sync"));
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
    const reader = streamResponse.body?.getReader();
    if (!reader) {
      throw new Error("Expected stream response body");
    }
    expect(await readNextChunk(reader)).toContain(": connected");

    const mutationResponse = await _runWithRequestInvalidationScope(() =>
      app.handle(
        new Request("http://localhost/cards/1", {
          headers: { "Idempotency-Key": "mutation-1" },
          method: "PATCH",
        })
      )
    );

    expect(mutationResponse.status).toBe(200);
    expect(mutationResponse.headers.get("x-furin-sync")).toBe("1");
    expect(mutationResponse.headers.get("x-furin-revalidate")).toBe("/board:layout");

    const event = await readNextChunk(reader);
    expect(event).toContain("event: furin.invalidate");
    expect(event).toContain("id: 1");
    expect(event).toContain("retry:");
    expect(event).toContain('"invalidations":["/board:layout"]');
  });

  test("rejects a repeated idempotency key without running the mutation twice", async () => {
    let calls = 0;
    const app = new Elysia().use(furinSync()).post(
      "/cards",
      () => {
        calls += 1;
        return { ok: true };
      },
      { sync: { path: "/board", type: "page" } }
    );
    const request = () =>
      _runWithRequestInvalidationScope(() =>
        app.handle(
          new Request("http://localhost/cards", {
            headers: { "Idempotency-Key": "create-1" },
            method: "POST",
          })
        )
      );

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(409);
    expect(calls).toBe(1);
  });

  test("replays missed invalidations after reconnect", async () => {
    const app = new Elysia()
      .use(createSyncStreamPlugin())
      .use(furinSync())
      .patch("/cards/:cardId", () => ({ ok: true }), {
        sync: { path: "/board", type: "page" },
      });

    await _runWithRequestInvalidationScope(() =>
      app.handle(
        new Request("http://localhost/cards/1", {
          headers: { "Idempotency-Key": "mutation-replay" },
          method: "PATCH",
        })
      )
    );
    const response = await app.handle(
      new Request("http://localhost/_furin/sync", { headers: { "Last-Event-ID": "0" } })
    );
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Expected stream response body");
    }
    expect(await readNextChunk(reader)).toContain("id: 1");
    await reader.cancel();
  });

  test("failed sync mutation does not publish invalidations", async () => {
    const app = new Elysia()
      .use(createSyncStreamPlugin())
      .use(furinSync())
      .delete("/cards/:cardId", ({ status }) => status("Not Found", "not found"), {
        sync: { invalidate: { path: "/board", type: "layout" } },
      });

    const response = await _runWithRequestInvalidationScope(() =>
      app.handle(
        new Request("http://localhost/cards/1", {
          headers: { "Idempotency-Key": "mutation-1" },
          method: "DELETE",
        })
      )
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("x-furin-sync")).toBeNull();
    expect(response.headers.get("x-furin-revalidate")).toBeNull();
  });

  test("injects sync runtime config into cached HTML idempotently", () => {
    const html = runWithSyncStreamPath("/_furin/sync", () =>
      injectSyncRuntimeScript("<html><body><main></main></body></html>")
    );
    const secondPass = runWithSyncStreamPath("/_furin/sync", () => injectSyncRuntimeScript(html));

    expect(html).toContain('id="__FURIN_SYNC__"');
    expect(html).toContain('"stream":"/_furin/sync"');
    expect(secondPass).toBe(html);
  });
});
