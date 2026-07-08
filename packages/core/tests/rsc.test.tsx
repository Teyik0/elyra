import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { CompositeComponent, createCompositeComponent, renderServerComponent } from "furin/rsc";
import type { ComponentType, ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import { createRoute, defer, type RuntimePage, type RuntimeRoute } from "../src/client";
import { serializeLoaderDataNdjson } from "../src/server/render/ssr";
import {
  createDataEndpoint,
  createRoutePlugin,
  type ResolvedRoute,
  type RootLayout,
} from "../src/server/router";
import { __setDevMode, IS_DEV } from "../src/server/runtime-env";
import { parseDeferredNdjson } from "../src/shared/deferred-ndjson";

describe("RSC public API", () => {
  function createRscRoute() {
    const route = createRoute({
      loader: async () => ({ article: await renderServerComponent(<h1>Flight article</h1>) }),
    });
    const page = route.page({ component: ({ article }) => <main>{article}</main> });
    const resolved = {
      mode: "ssr",
      page: page as unknown as RuntimePage,
      path: "/rsc.tsx",
      pattern: "/rsc",
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
    return { resolved, root };
  }

  test("renderServerComponent returns a React-renderable value", async () => {
    const article = await renderServerComponent(<h1>Composite RSC</h1>);

    const stream = await renderToReadableStream(<main>{article}</main>);
    const html = await new Response(stream).text();

    expect(html).toBe("<main><h1>Composite RSC</h1></main>");
  });

  test("a server-renderable value round-trips through the loader transport", async () => {
    const article = await renderServerComponent(<h1>Transported RSC</h1>);
    const payload = await serializeLoaderDataNdjson({ article }, undefined);
    const response = new Response(payload);

    const { syncData } = await parseDeferredNdjson(
      response.body as ReadableStream<Uint8Array>,
      undefined
    );
    const stream = await renderToReadableStream(<main>{syncData.article as ReactNode}</main>);

    expect(await new Response(stream).text()).toBe("<main><h1>Transported RSC</h1></main>");
  });

  test("initial SSR embeds Flight frames in the same document response", async () => {
    const { resolved, root } = createRscRoute();
    const app = new Elysia().use(createRoutePlugin(resolved, root));

    const html = await app
      .handle(new Request("http://localhost/rsc"))
      .then((response) => response.text());

    expect(html).toContain("Flight article");
    expect(html).toContain('id="__FURIN_ROUTE_FRAMES__"');
  });

  test("SPA navigation decodes the same Flight source", async () => {
    const { resolved } = createRscRoute();
    const app = new Elysia().use(createDataEndpoint([resolved]));
    const response = await app.handle(new Request("http://localhost/_furin/data?path=%2Frsc"));
    const { syncData } = await parseDeferredNdjson(
      response.body as ReadableStream<Uint8Array>,
      undefined
    );
    const stream = await renderToReadableStream(syncData.article as ReactNode);

    expect(await new Response(stream).text()).toBe("<h1>Flight article</h1>");
  });

  test("SPA navigation returns nested RSC data before deferred fields settle", async () => {
    let resolveSlow: ((value: string) => void) | undefined;
    const slow = new Promise<string>((resolve) => {
      resolveSlow = resolve;
    });
    const route = createRoute({
      loader: async () =>
        defer({
          content: { article: await renderServerComponent(<h1>Nested Flight article</h1>) },
          slow,
        }),
    });
    const page = route.page({ component: () => null });
    const resolved = {
      mode: "ssr",
      page: page as unknown as RuntimePage,
      path: "/nested-rsc.tsx",
      pattern: "/nested-rsc",
      routeChain: [route as unknown as RuntimeRoute],
      segmentBoundaries: [],
    } satisfies ResolvedRoute;
    const app = new Elysia().use(createDataEndpoint([resolved]));
    const response = await app.handle(
      new Request("http://localhost/_furin/data?path=%2Fnested-rsc")
    );

    expect(response.headers.get("content-type")).toBe("application/x-furin-route");
    const parsed = await Promise.race([
      parseDeferredNdjson(response.body as ReadableStream<Uint8Array>, undefined),
      Bun.sleep(100).then(() => {
        throw new Error("route frame parser waited for deferred data");
      }),
    ]);
    const content = parsed.syncData.content as { article: ReactNode };
    const stream = await renderToReadableStream(content.article);
    expect(await new Response(stream).text()).toBe("<h1>Nested Flight article</h1>");

    resolveSlow?.("done");
    expect(await parsed.deferredPromises.slow).toBe("done");
  });

  test("a composite invokes children and render-prop slots", async () => {
    const Card = await createCompositeComponent<{
      children: ReactNode;
      footer: (label: string) => ReactNode;
    }>(({ children, footer }) => (
      <article>
        {children}
        <footer>{footer("Loaded")}</footer>
      </article>
    ));

    const stream = await renderToReadableStream(
      <CompositeComponent footer={(label) => <button type="button">{label}</button>} src={Card}>
        <h2>Profile</h2>
      </CompositeComponent>
    );
    const html = await new Response(stream).text();

    expect(html).toBe(
      '<article><h2>Profile</h2><footer><button type="button">Loaded</button></footer></article>'
    );
  });

  test("a composite invokes a typed component slot", async () => {
    const Toolbar = await createCompositeComponent<{
      Action: ComponentType<{ label: string }>;
    }>(({ Action }) => (
      <nav>
        <Action label="Save" />
      </nav>
    ));

    const stream = await renderToReadableStream(
      <CompositeComponent
        Action={({ label }) => <button type="button">{label}</button>}
        src={Toolbar}
      />
    );
    const html = await new Response(stream).text();

    expect(html).toBe('<nav><button type="button">Save</button></nav>');
  });
});

const originalDevMode = IS_DEV;
beforeAll(() => __setDevMode(false));
afterAll(() => __setDevMode(originalDevMode));
