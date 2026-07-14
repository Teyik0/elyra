import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Suspense, use } from "react";
import { createRoute, type RuntimePage, type RuntimeRoute } from "../../../src/client";
import { revalidateTag } from "../../../src/server/auto-invalidate";
import { clearPprRouteCache, invalidatePprRoute } from "../../../src/server/render/ppr-route";
import { createRoutePlugin } from "../../../src/server/router/plugin.ts";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env";

(globalThis as typeof globalThis & { __FURIN_SKIP_DOM_RESET?: boolean }).__FURIN_SKIP_DOM_RESET =
  true;

afterEach(async () => {
  clearPprRouteCache();
  await Promise.resolve();
});
const originalDevMode = IS_DEV;
beforeAll(async () => {
  __setDevMode(false);
  await Promise.resolve();
});
afterAll(async () => {
  __setDevMode(originalDevMode);
  await Promise.resolve();
});

describe("partial prerendering", () => {
  test("an ISR route caches public data while requestLoader reruns per request", async () => {
    let publicCalls = 0;
    let privateCalls = 0;
    const route = createRoute({
      loader: () => {
        publicCalls += 1;
        return { catalog: "Shoes" };
      },
      mode: "isr",
      requestLoader: ({ cookies }) => {
        privateCalls += 1;
        return { user: cookies.get("session") };
      },
      revalidate: 60,
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

    const aliceResponse = await app.handle(
      new Request("http://localhost/account", { headers: { cookie: "session=alice" } })
    );
    const alice = await aliceResponse.text();
    const bob = await app
      .handle(new Request("http://localhost/account", { headers: { cookie: "session=bob" } }))
      .then((response) => response.text());

    expect(alice).toContain("Shoes");
    expect(alice).toContain("alice");
    expect(bob).toContain("bob");
    expect(aliceResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(publicCalls).toBe(1);
    expect(privateCalls).toBe(2);
  });

  test("keys PPR public shells by query string", async () => {
    let publicCalls = 0;
    const route = createRoute({
      loader: ({ query }) => {
        publicCalls += 1;
        return { view: String((query as { view?: unknown }).view ?? "") };
      },
      mode: "isr",
      requestLoader: () => ({ user: "alice" }),
      revalidate: 60,
    });
    function User({ data }: { data: Promise<{ user: string }> }) {
      return <strong>{use(data).user}</strong>;
    }
    const page = route.page({
      component: ({ requestData, view }) => (
        <main>
          <h1>{view}</h1>
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

    const alpha = await app
      .handle(new Request("http://localhost/account?view=alpha"))
      .then((response) => response.text());
    const beta = await app
      .handle(new Request("http://localhost/account?view=beta"))
      .then((response) => response.text());

    expect(alpha).toContain("alpha");
    expect(beta).toContain("beta");
    expect(publicCalls).toBe(2);

    expect(invalidatePprRoute("/account", "page")).toBe(true);
    await app.handle(new Request("http://localhost/account?view=alpha"));
    expect(publicCalls).toBe(3);
  });

  test("revalidateTag invalidates a PPR public shell", async () => {
    let catalog = "Shoes";
    let publicCalls = 0;
    const route = createRoute({
      loader: () => {
        publicCalls += 1;
        return { catalog };
      },
      mode: "isr",
      requestLoader: () => ({ user: "alice" }),
      revalidate: 60,
      tags: ["catalog"],
    });
    function User({ data }: { data: Promise<{ user: string }> }) {
      return <strong>{use(data).user}</strong>;
    }
    const page = route.page({
      component: ({ catalog: pageCatalog, requestData }) => (
        <main>
          <h1>{pageCatalog}</h1>
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
      tags: ["catalog"],
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

    const first = await app
      .handle(new Request("http://localhost/account"))
      .then((response) => response.text());
    catalog = "Boots";
    const stale = await app
      .handle(new Request("http://localhost/account"))
      .then((response) => response.text());

    expect(first).toContain("Shoes");
    expect(stale).toContain("Shoes");
    expect(publicCalls).toBe(1);
    expect(revalidateTag("catalog")).toBe(true);

    const fresh = await app
      .handle(new Request("http://localhost/account"))
      .then((response) => response.text());

    expect(fresh).toContain("Boots");
    expect(publicCalls).toBe(2);
  });

  test("streams a rejected requestData chunk instead of aborting the PPR response", async () => {
    const route = createRoute({
      loader: () => ({ catalog: "Shoes" }),
      mode: "isr",
      requestLoader: () => {
        throw new Error("private boom");
      },
      revalidate: 60,
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

    const html = await app
      .handle(new Request("http://localhost/account"))
      .then((response) => response.text());

    expect(html).toContain("Shoes");
    expect(html).toContain("__FURIN_ROUTE_FRAME_STREAM__");
    expect(html).toContain('\\"key\\":\\"requestData\\"');
    expect(html).toContain('\\"type\\":\\"defer-reject\\"');
  });
});
