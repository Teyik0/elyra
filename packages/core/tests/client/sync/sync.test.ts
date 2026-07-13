import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  __resetCacheState,
  _runWithRequestInvalidationScope,
} from "../../../src/server/cache/index.ts";
import { furinSync } from "../../../src/server/sync/plugin.ts";
import { __resetSyncState, createSyncStreamPlugin } from "../../../src/server/sync/stream.ts";

function resetSyncTestState() {
  __resetCacheState();
  __resetSyncState();
}

test("furinSync direct handle completes inside bun:test", async () => {
  resetSyncTestState();
  try {
    const app = new Elysia().use(furinSync()).post(
      "/cards",
      () => ({
        ok: true,
      }),
      { sync: { invalidate: { path: "/board", type: "layout" } } }
    );

    const response = await app.handle(
      new Request("http://localhost/cards", {
        headers: { "Idempotency-Key": "direct-handle" },
        method: "POST",
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-furin-revalidate")).toBe("/board:layout");
    expect(await response.json()).toEqual({ ok: true });
  } finally {
    resetSyncTestState();
  }
}, 1000);

test("furinSync enforces idempotent mutation semantics directly", async () => {
  resetSyncTestState();
  try {
    let calls = 0;
    const syncApp = new Elysia()
      .use(furinSync())
      .post("/synced", () => {
        calls += 1;
        return { calls };
      })
      .post(
        "/opted-out",
        () => {
          calls += 1;
          return { calls };
        },
        { sync: false }
      );

    let response = await syncApp.handle(new Request("http://localhost/synced", { method: "POST" }));
    expect(response.status).toBe(428);
    expect(calls).toBe(0);

    response = await syncApp.handle(new Request("http://localhost/opted-out", { method: "POST" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ calls: 1 });

    calls = 0;
    const replayApp = new Elysia().use(furinSync()).post("/cards", () => {
      calls += 1;
      return { calls };
    });
    const replayRequest = () =>
      replayApp.handle(
        new Request("http://localhost/cards", {
          body: JSON.stringify({ title: "First" }),
          headers: { "content-type": "application/json", "Idempotency-Key": "replay" },
          method: "POST",
        })
      );

    response = await replayRequest();
    expect(await response.json()).toEqual({ calls: 1 });
    response = await replayRequest();
    expect(await response.json()).toEqual({ calls: 1 });
    expect(calls).toBe(1);

    response = await replayApp.handle(
      new Request("http://localhost/cards", {
        body: JSON.stringify({ title: "Second" }),
        headers: { "content-type": "application/json", "Idempotency-Key": "replay" },
        method: "POST",
      })
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "FURIN_IDEMPOTENCY_MISMATCH" });

    calls = 0;
    const retryApp = new Elysia().use(furinSync()).post("/retry", ({ status }) => {
      calls += 1;
      return calls === 1 ? status("Service Unavailable", "retry") : { calls };
    });
    const retryRequest = () =>
      retryApp.handle(
        new Request("http://localhost/retry", {
          headers: { "Idempotency-Key": "retry" },
          method: "POST",
        })
      );
    expect((await retryRequest()).status).toBe(503);
    response = await retryRequest();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ calls: 2 });
  } finally {
    resetSyncTestState();
  }
});

test("furinSync SSE notification completes inside bun:test", async () => {
  resetSyncTestState();
  const app = new Elysia()
    .use(createSyncStreamPlugin())
    .use(furinSync())
    .patch("/cards/:cardId", () => ({ ok: true }), {
      sync: { invalidate: { path: "/board", type: "layout" } },
    });

  const streamResponse = await app.handle(new Request("http://localhost/_furin/sync"));
  const reader = streamResponse.body?.getReader();
  if (!reader) {
    throw new Error("Expected stream response body");
  }

  try {
    const connected = await reader.read();
    expect(new TextDecoder().decode(connected.value)).toContain(": connected");
    const response = await _runWithRequestInvalidationScope(() =>
      app.handle(
        new Request("http://localhost/cards/1", {
          headers: { "Idempotency-Key": "direct-sse" },
          method: "PATCH",
        })
      )
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-furin-revalidate")).toBe("/board:layout");

    const event = await reader.read();
    expect(new TextDecoder().decode(event.value)).toContain("event: furin.sync");
  } finally {
    await reader.cancel();
    resetSyncTestState();
  }
});
