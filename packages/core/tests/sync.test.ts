import { afterEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { furinSync } from "../src/furin.ts";
import { __resetCacheState, _runWithRequestInvalidationScope } from "../src/server/cache/index.ts";
import { injectSyncRuntimeScript } from "../src/server/render/assemble.ts";
import { runWithSyncStreamPath } from "../src/server/sync/config.ts";
import {
  __resetSyncState,
  createSyncStreamPlugin,
  publishSyncInvalidation,
} from "../src/server/sync/stream.ts";

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
  test("syncs mutations by default and allows explicit opt-out", async () => {
    let syncedCalls = 0;
    let optedOutCalls = 0;
    const app = new Elysia()
      .use(furinSync())
      .patch("/synced", () => {
        syncedCalls += 1;
        return { ok: true };
      })
      .post(
        "/opted-out",
        () => {
          optedOutCalls += 1;
          return { ok: true };
        },
        { sync: false }
      )
      .get("/read", () => ({ ok: true }));

    expect(
      (await app.handle(new Request("http://localhost/synced", { method: "PATCH" }))).status
    ).toBe(428);
    expect(
      (await app.handle(new Request("http://localhost/opted-out", { method: "POST" }))).status
    ).toBe(200);
    expect((await app.handle(new Request("http://localhost/read"))).status).toBe(200);
    expect(syncedCalls).toBe(0);
    expect(optedOutCalls).toBe(1);
  });

  test("rejects unsupported replay bodies unless the route opts out", async () => {
    const app = new Elysia()
      .use(furinSync())
      .post("/upload", () => ({ ok: true }))
      .post("/raw-upload", () => ({ ok: true }), { sync: false });
    const request = (path: string) =>
      app.handle(
        new Request(`http://localhost${path}`, {
          body: new Uint8Array([1, 2, 3]),
          headers: {
            "content-type": "application/octet-stream",
            "Idempotency-Key": "upload-1",
          },
          method: "POST",
        })
      );

    const synced = await request("/upload");
    expect(synced.status).toBe(415);
    expect(await synced.json()).toMatchObject({ code: "FURIN_UNSUPPORTED_SYNC_BODY" });
    expect((await request("/raw-upload")).status).toBe(200);
  });

  test("accepts JSON structured-suffix request bodies", async () => {
    const app = new Elysia().use(furinSync()).patch("/cards/1", () => ({ ok: true }));
    const response = await app.handle(
      new Request("http://localhost/cards/1", {
        body: JSON.stringify({ title: "Updated" }),
        headers: {
          "content-type": "application/merge-patch+json",
          "Idempotency-Key": "merge-patch-1",
        },
        method: "PATCH",
      })
    );

    expect(response.status).toBe(200);
  });

  test("replays a successful mutation response without executing the handler twice", async () => {
    let calls = 0;
    const app = new Elysia().use(furinSync()).post("/cards", ({ set }) => {
      calls += 1;
      set.status = 201;
      set.headers["x-result"] = "created";
      return { id: "card-1" };
    });
    const request = () =>
      app.handle(
        new Request("http://localhost/cards", {
          body: JSON.stringify({ title: "First" }),
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": "create-card-1",
          },
          method: "POST",
        })
      );

    const first = await request();
    const second = await request();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get("x-result")).toBe("created");
    expect(await second.json()).toEqual({ id: "card-1" });
    expect(calls).toBe(1);
  });

  test("replays Elysia status responses with their original body", async () => {
    let calls = 0;
    const app = new Elysia().use(furinSync()).post("/cards", ({ status }) => {
      calls += 1;
      return status("Created", { id: "card-1" });
    });
    const request = () =>
      app.handle(
        new Request("http://localhost/cards", {
          headers: { "Idempotency-Key": "status-response-1" },
          method: "POST",
        })
      );

    expect((await request()).status).toBe(201);
    const replay = await request();
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual({ id: "card-1" });
    expect(calls).toBe(1);
  });

  test("preserves handler objects that contain code and response fields", async () => {
    const app = new Elysia()
      .use(furinSync())
      .post("/cards", () => ({ code: 201, response: { id: "card-1" } }));
    const request = () =>
      app.handle(
        new Request("http://localhost/cards", {
          headers: { "Idempotency-Key": "object-response-1" },
          method: "POST",
        })
      );

    await request();
    const replay = await request();

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ code: 201, response: { id: "card-1" } });
  });

  test("replays repeated response headers separately", async () => {
    const app = new Elysia().use(furinSync()).post("/session", ({ set }) => {
      set.headers["set-cookie"] = ["first=1; Path=/", "second=2; Path=/"];
      return { ok: true };
    });
    const request = () =>
      app.handle(
        new Request("http://localhost/session", {
          headers: { "Idempotency-Key": "cookies-1" },
          method: "POST",
        })
      );

    await request();
    const replay = await request();

    expect(replay.headers.getSetCookie()).toEqual(["first=1; Path=/", "second=2; Path=/"]);
  });

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
    expect(event).toContain("event: furin.sync");
    expect(event).toContain("id: 1");
    expect(event).toContain("retry:");
    expect(event).toContain('"cursor":"1"');
  });

  test("replays a repeated idempotency key without running the mutation twice", async () => {
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
    const replay = await request();
    expect(replay.status).toBe(200);
    expect(replay.headers.get("x-furin-revalidate")).toBe("/board");
    expect(replay.headers.get("x-furin-sync")).toBe("1");
    expect(calls).toBe(1);
  });

  test("rejects reusing an idempotency key with a different payload", async () => {
    let calls = 0;
    const app = new Elysia().use(furinSync()).patch("/cards/1", () => {
      calls += 1;
      return { ok: true };
    });
    const request = (title: string) =>
      app.handle(
        new Request("http://localhost/cards/1", {
          body: JSON.stringify({ title }),
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": "rename-1",
          },
          method: "PATCH",
        })
      );

    expect((await request("First")).status).toBe(200);
    const mismatch = await request("Second");
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({ code: "FURIN_IDEMPOTENCY_MISMATCH" });
    expect(calls).toBe(1);
  });

  test("scopes idempotency replays to the authenticated principal", async () => {
    let calls = 0;
    const app = new Elysia().use(furinSync()).post("/cards", ({ request }) => {
      calls += 1;
      return { principal: request.headers.get("authorization") };
    });
    const request = (authorization: string) =>
      app.handle(
        new Request("http://localhost/cards", {
          headers: {
            authorization,
            "Idempotency-Key": "shared-key",
          },
          method: "POST",
        })
      );

    expect(await (await request("Bearer user-a")).json()).toEqual({
      principal: "Bearer user-a",
    });
    expect(await (await request("Bearer user-b")).json()).toEqual({
      principal: "Bearer user-b",
    });
    expect(await (await request("Bearer user-a")).json()).toEqual({
      principal: "Bearer user-a",
    });
    expect(calls).toBe(2);
  });

  test("rejects a concurrent mutation with the same idempotency key", async () => {
    let release: (() => void) | undefined;
    let markEntered: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const app = new Elysia().use(furinSync()).post("/cards", async () => {
      markEntered?.();
      await gate;
      return { ok: true };
    });
    const request = () =>
      app.handle(
        new Request("http://localhost/cards", {
          headers: { "Idempotency-Key": "concurrent-1" },
          method: "POST",
        })
      );

    const first = request();
    await entered;
    const conflict = await request();
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get("retry-after")).toBe("1");
    expect(await conflict.json()).toMatchObject({ code: "FURIN_MUTATION_IN_PROGRESS" });
    release?.();
    expect((await first).status).toBe(200);
  });

  test("allows an idempotency key to be retried after a failed mutation", async () => {
    let calls = 0;
    const app = new Elysia().use(furinSync()).post(
      "/cards",
      ({ status }) => {
        calls += 1;
        return calls === 1 ? status("Service Unavailable", "retry") : { ok: true };
      },
      { sync: { path: "/board", type: "page" } }
    );
    const request = () =>
      _runWithRequestInvalidationScope(() =>
        app.handle(
          new Request("http://localhost/cards", {
            headers: { "Idempotency-Key": "retry-1" },
            method: "POST",
          })
        )
      );

    expect((await request()).status).toBe(503);
    expect((await request()).status).toBe(200);
    expect(calls).toBe(2);
  });

  test("allows an idempotency key to be retried after a thrown mutation", async () => {
    let calls = 0;
    const app = new Elysia().use(furinSync()).post(
      "/cards",
      () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("temporary failure");
        }
        return { ok: true };
      },
      { sync: { path: "/board", type: "page" } }
    );
    const request = () =>
      _runWithRequestInvalidationScope(() =>
        app.handle(
          new Request("http://localhost/cards", {
            headers: { "Idempotency-Key": "retry-throw-1" },
            method: "POST",
          })
        )
      );

    expect((await request()).status).toBe(500);
    expect((await request()).status).toBe(200);
    expect(calls).toBe(2);
  });

  test("reads missed invalidations from the HTTP change log", async () => {
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
    const response = await app.handle(new Request("http://localhost/_furin/sync/changes?after=0"));
    expect(await response.json()).toEqual({
      changes: [{ cursor: "1", invalidations: ["/board"] }],
      cursor: "1",
      hasMore: false,
      reset: false,
    });
  });

  test("initializes at the current cursor without replaying history", async () => {
    publishSyncInvalidation(["/first"]);
    const app = new Elysia().use(createSyncStreamPlugin());

    const response = await app.handle(new Request("http://localhost/_furin/sync/changes"));

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      changes: [],
      cursor: "1",
      hasMore: false,
      reset: false,
    });
  });

  test("rejects invalid change cursors and limits", async () => {
    const app = new Elysia().use(createSyncStreamPlugin());

    const cursor = await app.handle(
      new Request("http://localhost/_furin/sync/changes?after=invalid")
    );
    const limit = await app.handle(new Request("http://localhost/_furin/sync/changes?limit=501"));

    expect(cursor.status).toBe(400);
    expect(limit.status).toBe(400);
  });

  test("isolates invalidations by stream path", async () => {
    const app = new Elysia()
      .use(createSyncStreamPlugin("/sync/one"))
      .use(createSyncStreamPlugin("/sync/two"));

    runWithSyncStreamPath("/sync/one", () => publishSyncInvalidation(["/one"]));
    runWithSyncStreamPath("/sync/two", () => publishSyncInvalidation(["/two"]));

    const firstResponse = await app.handle(
      new Request("http://localhost/sync/one/changes?after=0")
    );
    const secondResponse = await app.handle(
      new Request("http://localhost/sync/two/changes?after=0")
    );
    expect(await firstResponse.json()).toMatchObject({
      changes: [{ invalidations: ["/one"] }],
    });
    expect(await secondResponse.json()).toMatchObject({
      changes: [{ invalidations: ["/two"] }],
    });
  });

  test("sends a full invalidation when replay history has a gap", async () => {
    runWithSyncStreamPath("/_furin/sync", () => {
      for (let index = 0; index < 1001; index += 1) {
        publishSyncInvalidation([`/page-${index}`]);
      }
    });
    const app = new Elysia().use(createSyncStreamPlugin());
    const response = await app.handle(new Request("http://localhost/_furin/sync/changes?after=0"));
    expect(await response.json()).toMatchObject({
      changes: [{ invalidations: ["/:layout"] }],
      reset: true,
    });
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
