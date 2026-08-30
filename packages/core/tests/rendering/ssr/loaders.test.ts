import { describe, expect, test } from "bun:test";
import "../../setup/evlog-mock";

import type { Context } from "elysia";
import type { HTTPHeaders } from "elysia/types";
import { FurinRscRenderError } from "../../../src/rsc/render-error.ts";
import { runLoaders, runPublicLoaders } from "../../../src/server/render/loaders.ts";
import type { ResolvedRoute } from "../../../src/server/router/types.ts";
import { __setDevMode } from "../../../src/server/runtime-env.ts";
import { evlogErrorMock } from "../../setup/evlog-mock.ts";

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
  test("runs public and request loaders concurrently", async () => {
    const publicGate = Promise.withResolvers<void>();
    const requestGate = Promise.withResolvers<void>();
    const started: string[] = [];
    const route = {
      mode: "ssr",
      page: {},
      path: "/parallel.tsx",
      pattern: "/parallel",
      routeChain: [
        {
          __type: "FURIN_ROUTE",
          loader: async () => {
            started.push("public");
            await publicGate.promise;
            return {};
          },
          requestLoader: async () => {
            started.push("request");
            await requestGate.promise;
            return {};
          },
        },
      ],
      segmentBoundaries: [],
    } as unknown as ResolvedRoute;

    const result = runLoaders(route, createMockLoaderContext({ path: "/parallel" }));

    await Promise.resolve();
    expect(started).toEqual(["public", "request"]);
    publicGate.resolve();
    requestGate.resolve();
    await result;
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
      path: "/with-loader.tsx",
      pattern: "/with-loader",
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

  test("logs RSC render errors and preserves their development message", async () => {
    __setDevMode(true);
    evlogErrorMock.mockClear();
    const error = new FurinRscRenderError({
      cause: new TypeError("null is not an object (evaluating 'dispatcher.useContext')"),
      component: "PhoneIcon",
      hook: "useContext",
      operation: "createCompositeComponent",
    });
    const route = {
      mode: "ssr",
      page: {
        loader: () => {
          throw error;
        },
      },
      path: "/rsc-error.tsx",
      pattern: "/rsc-error",
      routeChain: [],
      segmentBoundaries: [],
    } as unknown as ResolvedRoute;

    try {
      const result = await runLoaders(route, createMockLoaderContext({ path: "/rsc-error" }));

      expect(result.type).toBe("error");
      if (result.type === "error") {
        expect(result.message).toContain("Component: PhoneIcon");
      }
      expect(evlogErrorMock).toHaveBeenCalledWith(error);
    } finally {
      __setDevMode(false);
    }
  });
});

__setDevMode(false);
