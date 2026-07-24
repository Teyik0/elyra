import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  autoInvalidateRegistry,
  revalidateTag,
} from "../../../src/server/auto-invalidate/index.ts";
import {
  __resetDevLoaderCacheState,
  invalidateDevLoaderCacheBySource,
  setDevISRLoaderCache,
} from "../../../src/server/cache/dev-loader.ts";
import { revalidatePathForInstance } from "../../../src/server/cache/invalidation.ts";
import { appendDevtoolsEvent, devtoolsEventsSnapshot } from "../../../src/server/devtools/hub.ts";
import { createDevtoolsPlugin } from "../../../src/server/devtools/plugin.ts";
import { currentInstance } from "../../../src/server/instance.ts";
import type { ResolvedRoute } from "../../../src/server/router/types.ts";

describe("native DevTools plugin", () => {
  test("rejects non-loopback hosts and cross-origin browser requests", async () => {
    const app = new Elysia().use(createDevtoolsPlugin([], undefined));

    const hostileHost = await app.handle(
      new Request("http://localhost/_furin/devtools/snapshot", {
        headers: { host: "attacker.test" },
      })
    );
    const hostileOrigin = await app.handle(
      new Request("http://localhost/_furin/devtools/snapshot", {
        headers: { origin: "https://attacker.test" },
      })
    );
    const local = await app.handle(
      new Request("http://localhost/_furin/devtools/snapshot", {
        headers: { origin: "http://localhost" },
      })
    );

    expect(hostileHost.status).toBe(403);
    expect(hostileOrigin.status).toBe(403);
    expect(local.status).toBe(200);
  });

  test("limits concurrent event streams and releases capacity on cancel", async () => {
    const app = new Elysia().use(createDevtoolsPlugin([], undefined));
    const streams = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.handle(new Request("http://localhost/_furin/devtools/events"))
      )
    );

    const rejected = await app.handle(new Request("http://localhost/_furin/devtools/events"));
    expect(rejected.status).toBe(429);

    await streams[0]?.body?.cancel();
    const replacement = await app.handle(new Request("http://localhost/_furin/devtools/events"));
    expect(replacement.status).toBe(200);

    await replacement.body?.cancel();
    await Promise.all(streams.slice(1).map((stream) => stream.body?.cancel()));
  });

  test("exposes a strict route snapshot without loader values or absolute paths", async () => {
    const route = {
      mode: "isr",
      page: {
        __type: "FURIN_PAGE",
        _route: { __type: "FURIN_ROUTE" },
        component: () => null,
        loader: () => ({ secret: "never expose me" }),
      },
      path: `${process.cwd()}/src/pages/blog/[slug].tsx`,
      pattern: "/blog/:slug",
      routeChain: [],
      segmentBoundaries: [],
      tags: ["posts"],
    } satisfies ResolvedRoute;
    const app = new Elysia().use(createDevtoolsPlugin([route], undefined));

    const response = await app.handle(new Request("http://localhost/_furin/devtools/snapshot"));
    const snapshot = await response.json();
    const serialized = JSON.stringify(snapshot);

    expect(response.status).toBe(200);
    expect(snapshot.version).toBe(1);
    expect(snapshot.routes).toEqual([
      {
        file: "src/pages/blog/[slug].tsx",
        hasLoader: true,
        hasRequestLoader: false,
        mode: "isr",
        pattern: "/blog/:slug",
        tags: ["posts"],
      },
    ]);
    expect(serialized).not.toContain("never expose me");
    expect(serialized).not.toContain(process.cwd());
  });

  test("redacts parent directory topology for sources outside the project", async () => {
    const route = {
      mode: "ssr",
      page: {
        __type: "FURIN_PAGE",
        _route: { __type: "FURIN_ROUTE" },
        component: () => null,
      },
      path: `${process.cwd()}/../private-project/pages/account.tsx`,
      pattern: "/account",
      routeChain: [],
      segmentBoundaries: [],
    } satisfies ResolvedRoute;
    const app = new Elysia().use(createDevtoolsPlugin([route], undefined));

    const response = await app.handle(new Request("http://localhost/_furin/devtools/snapshot"));
    const snapshot = await response.json();

    expect(snapshot.routes[0]?.file).toBe("account.tsx");
    expect(snapshot.routes[0]?.file).not.toContain("../");
    expect(snapshot.routes[0]?.file).not.toContain("private-project");
  });

  test("serves the standalone browser client outside the application bundle", async () => {
    const app = new Elysia().use(createDevtoolsPlugin([], undefined));
    const response = await app.handle(new Request("http://localhost/_furin/devtools/client.js"));
    const source = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(source).toContain("furin-devtools");
  });

  test("projects cache metadata without exposing cached values", async () => {
    const dependency = `${process.cwd()}/src/pages/posts.tsx`;
    setDevISRLoaderCache(`${dependency}:/posts?draft=1`, {
      dependencies: [dependency],
      generatedAt: Date.now(),
      headers: {},
      loaderData: {
        posts: [{ privateToken: "never expose cached values" }],
        total: 1,
      },
      mode: "isr",
      revalidate: 60,
    });
    const app = new Elysia().use(createDevtoolsPlugin([], undefined));

    const response = await app.handle(new Request("http://localhost/_furin/devtools/snapshot"));
    const snapshot = await response.json();
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.caches).toHaveLength(1);
    expect(snapshot.caches[0]).toMatchObject({
      dependencies: ["src/pages/posts.tsx"],
      fieldNames: ["posts", "total"],
      isFresh: true,
      mode: "isr",
      path: "/posts",
      revalidateSeconds: 60,
    });
    expect(serialized).not.toContain("never expose cached values");
    expect(serialized).not.toContain(process.cwd());
    __resetDevLoaderCacheState();
  });

  test("records path invalidations even outside a request", async () => {
    setDevISRLoaderCache(`${process.cwd()}/src/pages/posts.tsx:/posts`, {
      dependencies: [],
      generatedAt: Date.now(),
      headers: {},
      loaderData: {},
      mode: "isr",
      revalidate: 60,
    });
    revalidatePathForInstance(currentInstance(), "/posts", "page");
    const app = new Elysia().use(createDevtoolsPlugin([], undefined));

    const response = await app.handle(new Request("http://localhost/_furin/devtools/snapshot"));
    const snapshot = await response.json();
    const event = snapshot.events.find(
      (candidate: { type: string }) => candidate.type === "cache.invalidated"
    );

    expect(event).toMatchObject({
      deleted: true,
      reason: "path",
      target: "/posts",
    });
    __resetDevLoaderCacheState();
  });

  test("records source invalidations without absolute file paths", async () => {
    const source = `${process.cwd()}/src/pages/posts.tsx`;
    setDevISRLoaderCache(`${source}:/posts`, {
      dependencies: [source],
      generatedAt: Date.now(),
      headers: {},
      loaderData: {},
      mode: "isr",
      revalidate: 60,
    });
    invalidateDevLoaderCacheBySource(source);
    const app = new Elysia().use(createDevtoolsPlugin([], undefined));

    const response = await app.handle(new Request("http://localhost/_furin/devtools/snapshot"));
    const snapshot = await response.json();
    const event = snapshot.events.find(
      (candidate: { reason?: string }) => candidate.reason === "source"
    );

    expect(event).toMatchObject({
      deleted: true,
      reason: "source",
      target: "src/pages/posts.tsx",
    });
    expect(JSON.stringify(event)).not.toContain(process.cwd());
    __resetDevLoaderCacheState();
  });

  test("records tag invalidations as tag operations", async () => {
    setDevISRLoaderCache(`${process.cwd()}/src/pages/posts.tsx:/posts`, {
      dependencies: [],
      generatedAt: Date.now(),
      headers: {},
      loaderData: {},
      mode: "isr",
      revalidate: 60,
    });
    autoInvalidateRegistry.registerLoaderTags("/posts", ["posts"]);

    revalidateTag("posts");
    const event = devtoolsEventsSnapshot().events.findLast(
      (candidate) => candidate.type === "cache.invalidated"
    );

    expect(event).toMatchObject({
      deleted: true,
      reason: "tag",
      target: "posts",
    });
    __resetDevLoaderCacheState();
    autoInvalidateRegistry.reset();
    await Promise.resolve();
  });

  test("streams live events after the requested sequence", async () => {
    const app = new Elysia().use(createDevtoolsPlugin([], undefined));
    const cursor = devtoolsEventsSnapshot().lastEventId;
    const response = await app.handle(
      new Request(`http://localhost/_furin/devtools/events?after=${cursor}`)
    );
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const connected = await reader?.read();
    expect(new TextDecoder().decode(connected?.value)).toContain(": connected");

    appendDevtoolsEvent({
      method: "GET",
      operationId: null,
      path: "/live",
      requestId: "request-live",
      timestamp: Date.now(),
      type: "request.started",
    });
    const event = await reader?.read();
    const payload = new TextDecoder().decode(event?.value);

    expect(payload).toContain("event: furin.devtools");
    expect(payload).toContain('"path":"/live"');
    await reader?.cancel();
  });
});
