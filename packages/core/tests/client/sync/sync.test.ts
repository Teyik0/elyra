import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  __resetCacheState,
  _runWithRequestInvalidationScope,
} from "../../../src/server/cache/index.ts";
import type {
  BeginMutationInput,
  BeginMutationResult,
  ChangePage,
  CompleteMutationInput,
  CompleteMutationResult,
  MutationLease,
  ReadChangesInput,
  SyncAdapter,
  SyncNotifier,
} from "../../../src/server/sync/adapter.ts";
import { furinSync } from "../../../src/server/sync/plugin.ts";
import { MAX_SYNC_REPLAY_RESPONSE_BYTES } from "../../../src/server/sync/response.ts";
import { __resetSyncState, createSyncStreamPlugin } from "../../../src/server/sync/stream.ts";

type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  label: string,
  timeoutMs: number
): Promise<StreamReadResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);

    reader.read().then(
      (chunk) => {
        clearTimeout(timeout);
        resolve(chunk);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function resetSyncTestState() {
  __resetCacheState();
  __resetSyncState();
}

test("furinSync uses the injected adapter for reservation and atomic completion", async () => {
  const completed: CompleteMutationInput[] = [];
  const lease: MutationLease = {
    id: "lease-1",
    key: "POST:/cards:injected",
    leaseMs: 30_000,
    principal: "principal",
  };
  const adapter: SyncAdapter = {
    scope: "distributed",
    abortMutation: () => Promise.resolve(),
    beginMutation: (_input: BeginMutationInput): Promise<BeginMutationResult> =>
      Promise.resolve({ kind: "execute", lease }),
    completeMutation: (input: CompleteMutationInput): Promise<CompleteMutationResult> => {
      completed.push(input);
      return Promise.resolve({ cursor: "1", kind: "committed" });
    },
    currentCursor: () => Promise.resolve("0"),
    readChanges: (_input: ReadChangesInput): Promise<ChangePage> =>
      Promise.resolve({ changes: [], cursor: "0", hasMore: false, reset: false }),
    renewMutation: () => Promise.resolve("renewed"),
  };
  const notifier: SyncNotifier = {
    publish: () => Promise.reject(new Error("notifier unavailable")),
    subscribe: () => Promise.reject(new Error("notifier unavailable")),
  };
  const app = new Elysia()
    .use(furinSync({ adapter, notifier }))
    .post("/cards", () => ({ ok: true }));

  const response = await app.handle(
    new Request("http://localhost/cards", {
      headers: { "Idempotency-Key": "injected" },
      method: "POST",
    })
  );

  expect(response.status).toBe(200);
  expect(completed).toHaveLength(1);
  expect(completed[0]?.lease).toEqual(lease);
});

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

test("furinSync refuses unbounded Response bodies without re-executing retries", async () => {
  resetSyncTestState();
  try {
    let calls = 0;
    const app = new Elysia().use(furinSync()).post("/download", () => {
      calls += 1;
      return new Response("ok");
    });
    const request = () =>
      app.handle(
        new Request("http://localhost/download", {
          headers: { "Idempotency-Key": "unbounded-response" },
          method: "POST",
        })
      );

    let response = await request();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "FURIN_UNREPLAYABLE_SYNC_RESPONSE",
    });

    response = await request();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "FURIN_UNREPLAYABLE_SYNC_RESPONSE",
    });
    expect(calls).toBe(1);
  } finally {
    resetSyncTestState();
  }
});

test("furinSync replays bounded Response bodies", async () => {
  resetSyncTestState();
  try {
    let calls = 0;
    const app = new Elysia().use(furinSync()).post("/created", () => {
      calls += 1;
      return new Response("created", {
        headers: { "content-length": "7", "x-route": "created" },
        status: 201,
      });
    });
    const request = () =>
      app.handle(
        new Request("http://localhost/created", {
          headers: { "Idempotency-Key": "bounded-response" },
          method: "POST",
        })
      );

    let response = await request();
    expect(response.status).toBe(201);
    expect(response.headers.get("x-route")).toBe("created");
    expect(await response.text()).toBe("created");

    response = await request();
    expect(response.status).toBe(201);
    expect(response.headers.get("x-route")).toBe("created");
    expect(await response.text()).toBe("created");
    expect(calls).toBe(1);
  } finally {
    resetSyncTestState();
  }
});

test("furinSync refuses oversized Response bodies without re-executing retries", async () => {
  resetSyncTestState();
  try {
    let calls = 0;
    const app = new Elysia().use(furinSync()).post("/large", () => {
      calls += 1;
      return new Response("too large", {
        headers: { "content-length": String(MAX_SYNC_REPLAY_RESPONSE_BYTES + 1) },
      });
    });
    const request = () =>
      app.handle(
        new Request("http://localhost/large", {
          headers: { "Idempotency-Key": "oversized-response" },
          method: "POST",
        })
      );

    let response = await request();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "FURIN_UNREPLAYABLE_SYNC_RESPONSE",
    });

    response = await request();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "FURIN_UNREPLAYABLE_SYNC_RESPONSE",
    });
    expect(calls).toBe(1);
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
    const connected = await readStreamChunk(reader, "SSE connection prelude", 1000);
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

    const event = await readStreamChunk(reader, "SSE invalidation event", 1000);
    expect(new TextDecoder().decode(event.value)).toContain("event: furin.sync");
  } finally {
    await reader.cancel();
    resetSyncTestState();
  }
});

test("sync stream opens when notifier subscription fails", async () => {
  resetSyncTestState();
  const cursor = "0";
  const adapter: SyncAdapter = {
    scope: "distributed",
    abortMutation: () => Promise.resolve(),
    beginMutation: () => Promise.resolve({ kind: "unavailable" }),
    completeMutation: () => Promise.resolve({ kind: "lost" }),
    currentCursor: () => Promise.resolve(cursor),
    readChanges: () => Promise.resolve({ changes: [], cursor, hasMore: false, reset: false }),
    renewMutation: () => Promise.resolve("lost"),
  };
  const notifier: SyncNotifier = {
    publish: () => Promise.resolve(),
    subscribe: () => Promise.reject(new Error("notifier unavailable")),
  };
  const app = new Elysia().use(createSyncStreamPlugin(undefined, { adapter, notifier }));
  const response = await app.handle(new Request("http://localhost/_furin/sync"));
  try {
    expect(response.status).toBe(200);
  } finally {
    resetSyncTestState();
  }
});
