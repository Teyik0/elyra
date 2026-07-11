import { test } from "bun:test";
import { join as joinPath } from "node:path";

const script = `
const { expect } = await import("bun:test");
const { Elysia } = await import("elysia");
const { furinSync } = await import("./src/furin.ts");
const { __resetCacheState, _runWithRequestInvalidationScope } = await import("./src/server/cache/index.ts");
const { injectSyncRuntimeScript } = await import("./src/server/render/assemble.ts");
const { runWithSyncStreamPath } = await import("./src/server/sync/config.ts");
const { __resetSyncState, createSyncStreamPlugin, publishSyncInvalidation } = await import("./src/server/sync/stream.ts");

function resetState() {
  __resetCacheState();
  __resetSyncState();
}

async function readNextChunk(reader) {
  const timeout = new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error("Timed out waiting for sync event")), 1000);
  });
  const read = reader.read().then(({ value }) => (value ? new TextDecoder().decode(value) : ""));
  return await Promise.race([read, timeout]);
}

let syncedCalls = 0;
let optedOutCalls = 0;
let app = new Elysia()
  .use(furinSync())
  .patch("/synced", () => {
    syncedCalls += 1;
    return { ok: true };
  })
  .post("/opted-out", () => {
    optedOutCalls += 1;
    return { ok: true };
  }, { sync: false })
  .get("/read", () => ({ ok: true }));
expect((await app.handle(new Request("http://localhost/synced", { method: "PATCH" }))).status).toBe(428);
expect((await app.handle(new Request("http://localhost/opted-out", { method: "POST" }))).status).toBe(200);
expect((await app.handle(new Request("http://localhost/read"))).status).toBe(200);
expect(syncedCalls).toBe(0);
expect(optedOutCalls).toBe(1);

app = new Elysia()
  .use(furinSync())
  .post("/upload", () => ({ ok: true }))
  .post("/raw-upload", () => ({ ok: true }), { sync: false });
const uploadRequest = (path) =>
  app.handle(new Request("http://localhost" + path, {
    body: new Uint8Array([1, 2, 3]),
    headers: { "content-type": "application/octet-stream", "Idempotency-Key": "upload-1" },
    method: "POST",
  }));
let response = await uploadRequest("/upload");
expect(response.status).toBe(415);
expect(await response.json()).toMatchObject({ code: "FURIN_UNSUPPORTED_SYNC_BODY" });
expect((await uploadRequest("/raw-upload")).status).toBe(200);

app = new Elysia().use(furinSync()).patch("/cards/1", () => ({ ok: true }));
response = await app.handle(new Request("http://localhost/cards/1", {
  body: JSON.stringify({ title: "Updated" }),
  headers: { "content-type": "application/merge-patch+json", "Idempotency-Key": "merge-patch-1" },
  method: "PATCH",
}));
expect(response.status).toBe(200);

let calls = 0;
app = new Elysia().use(furinSync()).post("/cards", ({ set }) => {
  calls += 1;
  set.status = 201;
  set.headers["x-result"] = "created";
  return { id: "card-1" };
});
let request = () =>
  app.handle(new Request("http://localhost/cards", {
    body: JSON.stringify({ title: "First" }),
    headers: { "content-type": "application/json", "Idempotency-Key": "create-card-1" },
    method: "POST",
  }));
let first = await request();
let second = await request();
expect(first.status).toBe(201);
expect(second.status).toBe(201);
expect(second.headers.get("x-result")).toBe("created");
expect(await second.json()).toEqual({ id: "card-1" });
expect(calls).toBe(1);

calls = 0;
app = new Elysia().use(furinSync()).post("/cards", ({ status }) => {
  calls += 1;
  return status("Created", { id: "card-1" });
});
request = () => app.handle(new Request("http://localhost/cards", { headers: { "Idempotency-Key": "status-response-1" }, method: "POST" }));
expect((await request()).status).toBe(201);
response = await request();
expect(response.status).toBe(201);
expect(await response.json()).toEqual({ id: "card-1" });
expect(calls).toBe(1);

app = new Elysia().use(furinSync()).post("/cards", () => ({ code: 201, response: { id: "card-1" } }));
request = () => app.handle(new Request("http://localhost/cards", { headers: { "Idempotency-Key": "object-response-1" }, method: "POST" }));
await request();
response = await request();
expect(response.status).toBe(200);
expect(await response.json()).toEqual({ code: 201, response: { id: "card-1" } });

app = new Elysia().use(furinSync()).post("/session", ({ set }) => {
  set.headers["set-cookie"] = ["first=1; Path=/", "second=2; Path=/"];
  return { ok: true };
});
request = () => app.handle(new Request("http://localhost/session", { headers: { "Idempotency-Key": "cookies-1" }, method: "POST" }));
await request();
response = await request();
expect(response.headers.getSetCookie()).toEqual(["first=1; Path=/", "second=2; Path=/"]);

let called = false;
app = new Elysia().use(furinSync()).patch("/cards/:cardId", () => {
  called = true;
  return { ok: true };
}, { sync: { invalidate: { path: "/board", type: "layout" } } });
response = await _runWithRequestInvalidationScope(() =>
  app.handle(new Request("http://localhost/cards/1", { method: "PATCH" }))
);
expect(response.status).toBe(428);
expect(called).toBe(false);
expect(response.headers.get("x-furin-revalidate")).toBeNull();

resetState();
app = new Elysia()
  .use(createSyncStreamPlugin())
  .use(furinSync())
  .patch("/cards/:cardId", () => ({ id: "card-1", title: "Renamed" }), {
    sync: { invalidate: { path: "/board", type: "layout" } },
  });
const streamResponse = await app.handle(new Request("http://localhost/_furin/sync"));
expect(streamResponse.status).toBe(200);
const reader = streamResponse.body?.getReader();
if (!reader) throw new Error("Expected stream response body");
expect(await readNextChunk(reader)).toContain(": connected");
response = await _runWithRequestInvalidationScope(() =>
  app.handle(new Request("http://localhost/cards/1", { headers: { "Idempotency-Key": "mutation-1" }, method: "PATCH" }))
);
expect(response.status).toBe(200);
expect(response.headers.get("x-furin-sync")).toBe("1");
expect(response.headers.get("x-furin-revalidate")).toBe("/board:layout");
const event = await readNextChunk(reader);
expect(event).toContain("event: furin.sync");
expect(event).toContain("id: 1");
expect(event).toContain('"cursor":"1"');
await reader.cancel();

calls = 0;
app = new Elysia().use(furinSync()).post("/cards", () => {
  calls += 1;
  return { ok: true };
}, { sync: { path: "/board", type: "page" } });
request = () =>
  _runWithRequestInvalidationScope(() =>
    app.handle(new Request("http://localhost/cards", { headers: { "Idempotency-Key": "create-1" }, method: "POST" }))
  );
expect((await request()).status).toBe(200);
response = await request();
expect(response.status).toBe(200);
expect(response.headers.get("x-furin-revalidate")).toBe("/board");
expect(response.headers.get("x-furin-sync")).toBe("1");
expect(calls).toBe(1);

calls = 0;
app = new Elysia().use(furinSync()).patch("/cards/1", () => {
  calls += 1;
  return { ok: true };
});
request = (title) =>
  app.handle(new Request("http://localhost/cards/1", {
    body: JSON.stringify({ title }),
    headers: { "content-type": "application/json", "Idempotency-Key": "rename-1" },
    method: "PATCH",
  }));
expect((await request("First")).status).toBe(200);
response = await request("Second");
expect(response.status).toBe(409);
expect(await response.json()).toMatchObject({ code: "FURIN_IDEMPOTENCY_MISMATCH" });
expect(calls).toBe(1);

calls = 0;
app = new Elysia().use(furinSync()).post("/cards", ({ request }) => {
  calls += 1;
  return { principal: request.headers.get("authorization") };
});
request = (authorization, cookie) =>
  app.handle(new Request("http://localhost/cards", {
    headers: { authorization, cookie, "Idempotency-Key": "shared-key" },
    method: "POST",
  }));
expect(await (await request("Bearer user-a", "theme=light")).json()).toEqual({ principal: "Bearer user-a" });
expect(await (await request("Bearer user-b", "theme=light")).json()).toEqual({ principal: "Bearer user-b" });
expect(await (await request("Bearer user-a", "theme=dark")).json()).toEqual({ principal: "Bearer user-a" });
expect(calls).toBe(2);

let release;
let markEntered;
const gate = new Promise((resolve) => { release = resolve; });
const entered = new Promise((resolve) => { markEntered = resolve; });
app = new Elysia().use(furinSync()).post("/cards", async () => {
  markEntered?.();
  await gate;
  return { ok: true };
});
request = () => app.handle(new Request("http://localhost/cards", { headers: { "Idempotency-Key": "concurrent-1" }, method: "POST" }));
first = request();
await entered;
response = await request();
expect(response.status).toBe(409);
expect(response.headers.get("retry-after")).toBe("1");
expect(await response.json()).toMatchObject({ code: "FURIN_MUTATION_IN_PROGRESS" });
release?.();
expect((await first).status).toBe(200);

calls = 0;
app = new Elysia().use(furinSync()).post("/cards", ({ status }) => {
  calls += 1;
  return calls === 1 ? status("Service Unavailable", "retry") : { ok: true };
}, { sync: { path: "/board", type: "page" } });
request = () =>
  _runWithRequestInvalidationScope(() =>
    app.handle(new Request("http://localhost/cards", { headers: { "Idempotency-Key": "retry-1" }, method: "POST" }))
  );
expect((await request()).status).toBe(503);
expect((await request()).status).toBe(200);
expect(calls).toBe(2);

calls = 0;
app = new Elysia().use(furinSync()).post("/cards", () => {
  calls += 1;
  if (calls === 1) throw new Error("temporary failure");
  return { ok: true };
}, { sync: { path: "/board", type: "page" } });
request = () =>
  _runWithRequestInvalidationScope(() =>
    app.handle(new Request("http://localhost/cards", { headers: { "Idempotency-Key": "retry-throw-1" }, method: "POST" }))
  );
expect((await request()).status).toBe(500);
expect((await request()).status).toBe(200);
expect(calls).toBe(2);

resetState();
app = new Elysia()
  .use(createSyncStreamPlugin())
  .use(furinSync())
  .patch("/cards/:cardId", () => ({ ok: true }), { sync: { path: "/board", type: "page" } });
await _runWithRequestInvalidationScope(() =>
  app.handle(new Request("http://localhost/cards/1", { headers: { "Idempotency-Key": "mutation-replay" }, method: "PATCH" }))
);
response = await app.handle(new Request("http://localhost/_furin/sync/changes?after=0"));
expect(await response.json()).toEqual({
  changes: [{ cursor: "1", invalidations: ["/board"] }],
  cursor: "1",
  hasMore: false,
  reset: false,
});

resetState();
publishSyncInvalidation(["/first"]);
app = new Elysia().use(createSyncStreamPlugin());
response = await app.handle(new Request("http://localhost/_furin/sync/changes"));
expect(response.headers.get("cache-control")).toBe("no-store");
expect(await response.json()).toEqual({ changes: [], cursor: "1", hasMore: false, reset: false });

response = await app.handle(new Request("http://localhost/_furin/sync/changes?after=invalid"));
expect(response.status).toBe(400);
response = await app.handle(new Request("http://localhost/_furin/sync/changes?limit=501"));
expect(response.status).toBe(400);

resetState();
app = new Elysia().use(createSyncStreamPlugin("/sync/one")).use(createSyncStreamPlugin("/sync/two"));
runWithSyncStreamPath("/sync/one", () => publishSyncInvalidation(["/one"]));
runWithSyncStreamPath("/sync/two", () => publishSyncInvalidation(["/two"]));
response = await app.handle(new Request("http://localhost/sync/one/changes?after=0"));
expect(await response.json()).toMatchObject({ changes: [{ invalidations: ["/one"] }] });
response = await app.handle(new Request("http://localhost/sync/two/changes?after=0"));
expect(await response.json()).toMatchObject({ changes: [{ invalidations: ["/two"] }] });

resetState();
runWithSyncStreamPath("/_furin/sync", () => {
  for (let index = 0; index < 1001; index += 1) {
    publishSyncInvalidation(["/page-" + index]);
  }
});
app = new Elysia().use(createSyncStreamPlugin());
response = await app.handle(new Request("http://localhost/_furin/sync/changes?after=0"));
expect(await response.json()).toMatchObject({ changes: [{ invalidations: ["/:layout"] }], reset: true });

resetState();
app = new Elysia()
  .use(createSyncStreamPlugin())
  .use(furinSync())
  .delete("/cards/:cardId", ({ status }) => status("Not Found", "not found"), {
    sync: { invalidate: { path: "/board", type: "layout" } },
  });
response = await _runWithRequestInvalidationScope(() =>
  app.handle(new Request("http://localhost/cards/1", { headers: { "Idempotency-Key": "mutation-failed" }, method: "DELETE" }))
);
expect(response.status).toBe(404);
expect(response.headers.get("x-furin-sync")).toBeNull();
expect(response.headers.get("x-furin-revalidate")).toBeNull();

const html = runWithSyncStreamPath("/_furin/sync", () =>
  injectSyncRuntimeScript("<html><body><main></main></body></html>")
);
const secondPass = runWithSyncStreamPath("/_furin/sync", () => injectSyncRuntimeScript(html));
expect(html).toContain('id="__FURIN_SYNC__"');
expect(html).toContain('"stream":"/_furin/sync"');
expect(secondPass).toBe(html);
`;

test("furinSync scenarios", () => {
  const proc = Bun.spawnSync({
    cmd: ["bun", "--preload", "../../tests/setup.ts", "-e", script],
    cwd: joinPath(import.meta.dir, ".."),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      [
        `furinSync subprocess exited with ${proc.exitCode}`,
        new TextDecoder().decode(proc.stdout),
        new TextDecoder().decode(proc.stderr),
      ].join("\n")
    );
  }
});
