import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createRoute, type RuntimePage, type RuntimeRoute } from "../../../src/client";
import { __resetCacheState, revalidatePath } from "../../../src/server/cache/index.ts";
import { createRoutePlugin } from "../../../src/server/router/plugin.ts";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";

(globalThis as typeof globalThis & { __FURIN_SKIP_DOM_RESET?: boolean }).__FURIN_SKIP_DOM_RESET =
  true;

const originalDevMode = IS_DEV;

beforeAll(async () => {
  __setDevMode(false);
  __resetCacheState();
  await Promise.resolve();
});

afterEach(async () => {
  __resetCacheState();
  await Promise.resolve();
});

afterAll(async () => {
  __setDevMode(originalDevMode);
  await Promise.resolve();
});

test("ISR cache keys include the query string and path invalidation clears every variant", async () => {
  let loaderCalls = 0;
  const route = createRoute({
    loader: ({ query }) => {
      loaderCalls += 1;
      return { tenant: String((query as { tenant?: unknown }).tenant ?? "") };
    },
    mode: "isr",
    revalidate: 60,
  });
  const page = route.page({
    component: ({ tenant }) => <main data-tenant={tenant}>{tenant}</main>,
  });
  const resolved = {
    mode: "isr",
    page: page as unknown as RuntimePage,
    path: "/search.tsx",
    pattern: "/search",
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
    .handle(new Request("http://localhost/search?tenant=alpha"))
    .then((response) => response.text());
  const beta = await app
    .handle(new Request("http://localhost/search?tenant=beta"))
    .then((response) => response.text());

  expect(alpha).toContain("alpha");
  expect(beta).toContain("beta");
  expect(loaderCalls).toBe(2);

  expect(revalidatePath("/search", "page")).toBe(true);

  await app.handle(new Request("http://localhost/search?tenant=alpha"));
  await app.handle(new Request("http://localhost/search?tenant=beta"));
  expect(loaderCalls).toBe(4);
});
