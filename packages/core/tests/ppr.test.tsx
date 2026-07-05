import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Suspense, use } from "react";
import { createRoute, type RuntimePage, type RuntimeRoute } from "../src/client";
import { prerenderPpr, resumePpr } from "../src/server/render/ppr";
import { clearPprRouteCache } from "../src/server/render/ppr-route";
import { createRoutePlugin, type ResolvedRoute, type RootLayout } from "../src/server/router";
import { __setDevMode, IS_DEV } from "../src/server/runtime-env";

afterEach(() => clearPprRouteCache());
const originalDevMode = IS_DEV;
beforeAll(() => __setDevMode(false));
afterAll(() => __setDevMode(originalDevMode));

describe("partial prerendering", () => {
  test("caches a public shell and resumes request data with React", async () => {
    let resolveUser: ((value: string) => void) | undefined;
    const requestData = new Promise<string>((resolve) => {
      resolveUser = resolve;
    });
    function PrivateUser() {
      return <strong>{use(requestData)}</strong>;
    }
    const page = (
      <main>
        <h1>Public catalog</h1>
        <Suspense fallback={<span>Loading user</span>}>
          <PrivateUser />
        </Suspense>
      </main>
    );

    const entry = await prerenderPpr(page, {
      abortAfterMs: 20,
      buildId: "build-1",
      publicRouteStream: new Uint8Array([1, 2, 3]),
      status: 200,
    });
    const shell = new TextDecoder().decode(entry.shell);
    expect(shell).toContain("Public catalog");
    expect(shell).not.toContain("Alice");

    resolveUser?.("Alice");
    const resumed = await resumePpr(page, entry.postponedState, undefined);
    expect(new TextDecoder().decode(resumed)).toContain("Alice");
  });

  test("an ISR route caches public data while requestLoader reruns per request", async () => {
    let publicCalls = 0;
    let privateCalls = 0;
    const route = createRoute({
      mode: "isr",
      revalidate: 60,
      loader: () => {
        publicCalls += 1;
        return { catalog: "Shoes" };
      },
      requestLoader: ({ cookies }) => {
        privateCalls += 1;
        return { user: cookies.get("session") };
      },
    });
    function User({ data }: { data: Promise<{ user: unknown }> }) {
      return <strong>{String(use(data).user)}</strong>;
    }
    const page = route.page({
      component: ({ catalog, requestData }) => (
        <main>
          <h1>{catalog}</h1>
          <Suspense fallback={<span>Loading</span>}>
            <User data={requestData} />
          </Suspense>
        </main>
      ),
    });
    const resolved = {
      mode: "isr",
      page: page as unknown as RuntimePage,
      path: "/account.tsx",
      pattern: "/account",
      routeChain: [route as unknown as RuntimeRoute],
      segmentBoundaries: [],
    } satisfies ResolvedRoute;
    const root = {
      path: "/root.tsx",
      route: {
        __type: "FURIN_ROUTE",
        layout: ({ children }) => (
          <html lang="en">
            <body>{children}</body>
          </html>
        ),
      },
    } satisfies RootLayout;
    const app = new Elysia().use(createRoutePlugin(resolved, root, "build-1"));

    const alice = await app
      .handle(new Request("http://localhost/account", { headers: { cookie: "session=alice" } }))
      .then((response) => response.text());
    const bob = await app
      .handle(new Request("http://localhost/account", { headers: { cookie: "session=bob" } }))
      .then((response) => response.text());

    expect(alice).toContain("Shoes");
    expect(alice).toContain("alice");
    expect(bob).toContain("bob");
    expect(publicCalls).toBe(1);
    expect(privateCalls).toBe(2);
  });
});
