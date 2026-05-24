import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("evlog", () => ({
  createLogger: (ctx: Record<string, unknown>) => ({
    set: (data: Record<string, unknown>) => {
      Object.assign(ctx, data);
    },
    error: (err: Error) => {
      ctx.error = err;
    },
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
    emit: () => {},
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
    info: () => {},
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
    warn: () => {},
    getContext: () => ctx,
    fork: (_label: string, fn: () => unknown) => fn(),
  }),
}));

mock.module("evlog/elysia", () => ({
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
  useLogger: () => ({ set() {} }),
  evlog: () => (app: unknown) => app,
}));

import { Elysia } from "elysia";
import { autoInvalidateRegistry, furinInvalidate, revalidateTag } from "../src/auto-invalidate";
import {
  __resetCacheState,
  _runWithRequestInvalidationScope,
  consumePendingInvalidations,
  isrCache,
  setISRCache,
  setSSGCache,
  ssgCache,
} from "../src/render/cache";
import {
  __resetDevLoaderCacheState,
  getDevISRLoaderCache,
  getDevSSGLoaderCache,
  setDevISRLoaderCache,
  setDevSSGLoaderCache,
} from "../src/render/dev-cache";

afterEach(() => {
  __resetCacheState();
  __resetDevLoaderCacheState();
  autoInvalidateRegistry.reset();
});

describe("revalidateTag", () => {
  test("invalidates every production cache path registered under a tag", () => {
    setISRCache("/board/123", { generatedAt: Date.now(), html: "board", revalidate: 60 });
    setSSGCache("/", { cachedAt: Date.now(), html: "home", ndjson: "{}\n", status: 200 });
    setISRCache("/untagged", { generatedAt: Date.now(), html: "other", revalidate: 60 });

    autoInvalidateRegistry.registerLoaderTags("/board/123", ["board"]);
    autoInvalidateRegistry.registerLoaderTags("/", ["boards"]);

    const deleted = revalidateTag("board");

    expect(deleted).toBe(true);
    expect(isrCache.has("/board/123")).toBe(false);
    expect(ssgCache.has("/")).toBe(true);
    expect(isrCache.has("/untagged")).toBe(true);
  });

  test("invalidates dev loader caches registered under a tag", () => {
    const entry = {
      dependencies: [],
      generatedAt: Date.now(),
      headers: {},
      loaderData: {},
      mode: "isr" as const,
      revalidate: 60,
    };
    setDevISRLoaderCache("/repo/src/pages/root.tsx:/board/123", entry);
    setDevSSGLoaderCache("/repo/src/pages/root.tsx:/", { ...entry, mode: "ssg" });

    autoInvalidateRegistry.registerLoaderTags("/board/123", ["board"]);
    autoInvalidateRegistry.registerLoaderTags("/", ["boards"]);

    const deleted = revalidateTag(["board", "boards"]);

    expect(deleted).toBe(true);
    expect(getDevISRLoaderCache("/repo/src/pages/root.tsx:/board/123")).toBeUndefined();
    expect(getDevSSGLoaderCache("/repo/src/pages/root.tsx:/")).toBeUndefined();
  });

  test("unregisters tag mappings when cached paths are evicted", () => {
    setISRCache("/board/123", { generatedAt: Date.now(), html: "board", revalidate: 60 });
    autoInvalidateRegistry.registerLoaderTags("/board/123", ["board"]);

    revalidateTag("board");
    const second = revalidateTag("board");

    expect(second).toBe(false);
  });
});

describe("furinInvalidate macro", () => {
  test("runs invalidation rules on successful mutation responses", async () => {
    setISRCache("/board/123", { generatedAt: Date.now(), html: "board", revalidate: 60 });
    autoInvalidateRegistry.registerLoaderTags("/board/123", ["board"]);

    const app = new Elysia()
      .use(furinInvalidate())
      .post("/cards", () => ({ ok: true }), { invalidate: { tags: ["board"] } });

    const response = await _runWithRequestInvalidationScope(() =>
      app.handle(new Request("http://localhost/cards", { method: "POST" }))
    );

    expect(response.status).toBe(200);
    expect(isrCache.has("/board/123")).toBe(false);
    expect(response.headers.get("x-furin-revalidate")).toBe("/board/123");
    expect(consumePendingInvalidations()).toEqual([]);
  });

  test("does not invalidate failed mutation responses", async () => {
    setISRCache("/board/123", { generatedAt: Date.now(), html: "board", revalidate: 60 });
    autoInvalidateRegistry.registerLoaderTags("/board/123", ["board"]);

    const app = new Elysia()
      .use(furinInvalidate())
      .post("/cards", ({ status }) => status("Bad Request", "bad"), {
        invalidate: { tags: ["board"] },
      });

    const response = await _runWithRequestInvalidationScope(() =>
      app.handle(new Request("http://localhost/cards", { method: "POST" }))
    );

    expect(response.status).toBe(400);
    expect(isrCache.has("/board/123")).toBe(true);
    expect(response.headers.get("x-furin-revalidate")).toBeNull();
  });

  test("data endpoint re-registers loader tags after a SPA-only fetch (regression for delete-then-stale-UI)", async () => {
    // Repro of the task-manager bug: after a mutation invalidates a page, the
    // dev cache's onDelete hook unregisters the path from the auto-invalidate
    // registry. The next SPA refresh hits `/_furin/data?path=…`, runs the
    // loader fresh, and used to NOT re-register the tag mapping — so a
    // subsequent mutation's `revalidateTag` found nothing and the response
    // shipped no `x-furin-revalidate` header, leaving the UI stale forever.
    const { scanPages } = await import("../src/router");
    const { routes } = await scanPages(`${import.meta.dirname}/fixtures/pages`);
    const route = routes.find((r) => r.pattern === "/with-loader");
    if (!route?.page) {
      throw new Error("No /with-loader route in fixtures");
    }
    // Inject a `tags: ["boards"]` declaration on the page so the loader run
    // produces a registration. The route's runtime shape carries `.tags`
    // (see ResolvedRoute.tags / collectRouteTags in router.ts).
    (route as unknown as { tags: string[] }).tags = ["boards"];

    const { createDataEndpoint } = await import("../src/router");
    const app = new Elysia().use(createDataEndpoint(routes));

    autoInvalidateRegistry.reset();
    expect(autoInvalidateRegistry.pathsForTags(["boards"])).toEqual([]);

    const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fwith-loader"));
    expect(res.status).toBe(200);

    // After a successful loader run, the data endpoint must have registered
    // the urlPath with the page's tags.
    expect(autoInvalidateRegistry.pathsForTags(["boards"])).toEqual(["/with-loader"]);
  });

  test("two plugins both calling furinInvalidate() + DELETE → header still set (task-manager replica)", async () => {
    // The real task-manager has both boardPlugin and cardPlugin each call
    // `.use(furinInvalidate())`. Both Elysia instances share the same plugin
    // name `furin-invalidate`. This test verifies the second plugin still
    // sees the macro applied to its DELETE route.
    setISRCache("/", { generatedAt: Date.now(), html: "home", revalidate: 10 });
    autoInvalidateRegistry.registerLoaderTags("/", ["boards"]);

    const boardPlugin = new Elysia()
      .use(furinInvalidate())
      .post("/boards", () => ({ id: "x" }), { invalidate: { tags: ["boards"] } })
      .delete("/boards/:id", () => ({ ok: true }), { invalidate: { tags: ["boards"] } });

    const cardPlugin = new Elysia()
      .use(furinInvalidate())
      .post("/cards", () => ({ ok: true }), { invalidate: { tags: ["cards"] } });

    const api = new Elysia({ prefix: "/api" }).use(boardPlugin).use(cardPlugin);

    const response = await _runWithRequestInvalidationScope(() =>
      api.handle(new Request("http://localhost/api/boards/abc", { method: "DELETE" }))
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-furin-revalidate")).toBe("/");
    expect(isrCache.has("/")).toBe(false);
  });

  test("wrap-with-scope (mirrors furin server) + nested DELETE → header still set (regression for real-server bug)", async () => {
    // Reproduces the exact AsyncLocalStorage wrapping pattern used by
    // `wrapWithRequestScope` in furin.ts to confirm that `app.wrap` preserves
    // the request-scoped invalidation set across the macro afterHandle.
    setISRCache("/", { generatedAt: Date.now(), html: "home", revalidate: 10 });
    autoInvalidateRegistry.registerLoaderTags("/", ["boards"]);

    const inner = new Elysia()
      .use(furinInvalidate())
      .delete("/boards/:id", () => ({ ok: true }), { invalidate: { tags: ["boards"] } });

    const api = new Elysia({ prefix: "/api" }).use(inner);

    // Mirror `wrapWithRequestScope`: app.wrap(...) — installs the AsyncLocalStorage
    // scope around the composed handler instead of using the test helper.
    const wrapped = new Elysia()
      .use(api)
      .wrap(
        (handler, _request) => (ctx: unknown) =>
          _runWithRequestInvalidationScope(() => handler(ctx))
      );

    // Note: we deliberately do NOT use _runWithRequestInvalidationScope here —
    // the .wrap() above should be sufficient.
    const response = await wrapped.handle(
      new Request("http://localhost/api/boards/abc", { method: "DELETE" })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-furin-revalidate")).toBe("/");
  });

  test("nested plugin + prefix + DELETE with params → tag invalidation still works", async () => {
    // Mirrors the task-manager structure exactly: a nested plugin that calls
    // furinInvalidate() and is mounted under a prefix, with a DELETE that has
    // a dynamic param. This is the configuration that was reported as broken.
    setISRCache("/", { generatedAt: Date.now(), html: "home", revalidate: 10 });
    autoInvalidateRegistry.registerLoaderTags("/", ["boards"]);

    const boardPlugin = new Elysia()
      .use(furinInvalidate())
      .get("/boards", () => ({ list: [] }))
      .post("/boards", () => ({ id: "new" }), { invalidate: { tags: ["boards"] } })
      .delete("/boards/:boardId", () => ({ ok: true }), {
        invalidate: { tags: ["boards"] },
      })
      .get("/boards/:boardId", () => ({ id: "x" }));

    const api = new Elysia({ prefix: "/api" }).use(boardPlugin);

    const response = await _runWithRequestInvalidationScope(() =>
      api.handle(new Request("http://localhost/api/boards/abc", { method: "DELETE" }))
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-furin-revalidate")).toBe("/");
    expect(isrCache.has("/")).toBe(false);
  });

  test("DELETE + tag-based invalidate → header is set and cache is busted (regression)", async () => {
    // Mirrors the task-manager DELETE /boards/:id flow that was failing:
    // the home page caches under tag "boards"; deleting a board should bust
    // it and ship x-furin-revalidate: / on the DELETE response so the client
    // refreshes the home page.
    setISRCache("/", { generatedAt: Date.now(), html: "home", revalidate: 10 });
    autoInvalidateRegistry.registerLoaderTags("/", ["boards"]);

    const app = new Elysia()
      .use(furinInvalidate())
      .delete("/boards/:id", () => ({ ok: true }), { invalidate: { tags: ["boards"] } });

    const response = await _runWithRequestInvalidationScope(() =>
      app.handle(new Request("http://localhost/boards/abc", { method: "DELETE" }))
    );

    expect(response.status).toBe(200);
    expect(isrCache.has("/")).toBe(false);
    expect(response.headers.get("x-furin-revalidate")).toBe("/");
  });

  test("supports path-based invalidation rules", async () => {
    setISRCache("/blog/post", { generatedAt: Date.now(), html: "post", revalidate: 60 });

    const app = new Elysia().use(furinInvalidate()).delete("/posts/1", () => ({ ok: true }), {
      invalidate: { path: "/blog/post", type: "page" },
    });

    const response = await _runWithRequestInvalidationScope(() =>
      app.handle(new Request("http://localhost/posts/1", { method: "DELETE" }))
    );

    expect(response.status).toBe(200);
    expect(isrCache.has("/blog/post")).toBe(false);
    expect(response.headers.get("x-furin-revalidate")).toBe("/blog/post");
  });
});
