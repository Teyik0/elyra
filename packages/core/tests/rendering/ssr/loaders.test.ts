import { describe, expect, test } from "bun:test";
import "../../setup/evlog-mock";

import type { Context } from "elysia";
import type { HTTPHeaders } from "elysia/types";
import { runLoaders, runPublicLoaders } from "../../../src/server/render/loaders.ts";
import type { ResolvedRoute } from "../../../src/server/router/index.ts";
import { __setDevMode } from "../../../src/server/runtime-env.ts";

const CACHED_PUBLIC_LOADERS_RE = /Cached public loaders/;

function createMockLoaderContext(overrides: Partial<Context>): Context {
  return {
    cookie: {},
    headers: {},
    params: {},
    path: "/test",
    query: {},
    redirect: (url: string) => new Response(null, { headers: { Location: url }, status: 302 }),
    request: new Request("http://localhost/test"),
    set: { headers: {} as HTTPHeaders },
    ...overrides,
  } as Context;
}

describe("runLoaders requestLoader", () => {
  test("starts public loaders before synchronous requestLoader work", async () => {
    const started: string[] = [];
    const route = {
      mode: "ssr",
      page: {},
      routeChain: [
        {
          __type: "FURIN_ROUTE",
          loader: () => {
            started.push("public");
            return {};
          },
          requestLoader: () => {
            started.push("request");
            return {};
          },
        },
      ],
      path: "/parallel.tsx",
      pattern: "/parallel",
      segmentBoundaries: [],
    } as unknown as ResolvedRoute;

    const result = runLoaders(route, createMockLoaderContext({ path: "/parallel" }));

    expect(started).toEqual(["public"]);
    await result;
    expect(started).toEqual(["public", "request"]);
  });

  test("rejects loader data that uses framework-reserved keys", async () => {
    const route = {
      mode: "ssr",
      page: {
        loader: () => ({ __furinStatus: 404 }),
      },
      path: "/reserved.tsx",
      pattern: "/reserved",
      routeChain: [],
      segmentBoundaries: [],
    } as unknown as ResolvedRoute;

    const result = await runLoaders(route, createMockLoaderContext({ path: "/reserved" }));

    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain('__furinStatus" is reserved');
    }
  });

  test("runs private data once with a read-only request context", async () => {
    let calls = 0;
    const route = {
      mode: "ssr",
      page: {},
      routeChain: [
        {
          __type: "FURIN_ROUTE",
          requestLoader: (ctx: { cookies: Map<string, string | undefined> }) => {
            calls += 1;
            expect("set" in ctx).toBe(false);
            expect("redirect" in ctx).toBe(false);
            return { user: ctx.cookies.get("session") };
          },
        },
      ],
      path: "/with-loader.tsx",
      pattern: "/with-loader",
      segmentBoundaries: [],
    } as unknown as ResolvedRoute;
    const context = createMockLoaderContext({
      cookie: { session: { value: "alice" } } as unknown as Context["cookie"],
      path: "/with-loader",
    });

    const result = await runLoaders(route, context);

    expect(result.type).toBe("data");
    if (result.type === "data") {
      expect(await result.deferredPromises?.requestData).toEqual({ user: "alice" });
    }
    expect(calls).toBe(1);
  });

  test("public loaders omit decorated context fields", async () => {
    const route = {
      mode: "ssr",
      page: {
        loader: (ctx: { [key: string]: unknown }) => ({ service: ctx.service }),
      },
      path: "/decorated.tsx",
      pattern: "/decorated",
      routeChain: [],
      segmentBoundaries: [],
    } as unknown as ResolvedRoute;
    const context = createMockLoaderContext({
      service: "decorated",
    } as Partial<Context>);

    const result = await runPublicLoaders(route, context);

    expect(result.type).toBe("data");
    if (result.type === "data") {
      expect(await result.syncData.service).toBeUndefined();
    }
  });

  test("public loaders cannot mutate cached response state", async () => {
    const route = {
      mode: "ssr",
      page: {
        loader: (ctx: { [key: string]: unknown }) => ({ set: ctx.set }),
      },
      path: "/blocked.tsx",
      pattern: "/blocked",
      routeChain: [],
      segmentBoundaries: [],
    } as unknown as ResolvedRoute;

    const result = await runPublicLoaders(route, createMockLoaderContext({}));

    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.message).toBe("Something went wrong");
      expect((result.error as Error).message).toMatch(CACHED_PUBLIC_LOADERS_RE);
    }
  });
});

__setDevMode(false);
