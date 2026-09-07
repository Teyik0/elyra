import { afterAll, beforeAll, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { defineRootRoute, defineRoute, HeadContent, Scripts } from "../../../src/furin.ts";
import { renderRootNotFound } from "../../../src/server/render/not-found.ts";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import { createRoutePlugin } from "../../../src/server/router/plugin.ts";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";

(globalThis as typeof globalThis & { __FURIN_SKIP_DOM_RESET?: boolean }).__FURIN_SKIP_DOM_RESET =
  true;

const originalDevMode = IS_DEV;

beforeAll((done) => {
  __setDevMode(false);
  done();
});

afterAll((done) => {
  __setDevMode(originalDevMode);
  done();
});

interface DocumentAppOptions {
  mode: "isr" | "ssr";
  pageTerminal: Parameters<typeof adaptDefinedPage>[0];
  pattern: string;
  rootError?: RootLayout["error"];
  rootTerminal: Parameters<typeof adaptDefinedLayout>[0];
}

function createDocumentApp(options: DocumentAppOptions): Elysia {
  const root = {
    ...(options.rootError ? { error: options.rootError } : {}),
    path: "/root.tsx",
    route: adaptDefinedLayout(options.rootTerminal, undefined),
  } satisfies RootLayout;
  const page = adaptDefinedPage(options.pageTerminal, root.route);
  const route = {
    mode: options.mode,
    page,
    path: `${options.pattern}.tsx`,
    pattern: options.pattern,
    routeChain: collectRouteChainFromRoute(page._route),
    segmentBoundaries: [],
  } satisfies ResolvedRoute;
  return new Elysia().use(createRoutePlugin(route, root, "document-build"));
}

test("the root layout owns the rendered document", async () => {
  const rootTerminal = defineRootRoute()
    .config({ mode: "ssr" })
    .layout(({ children }) => (
      <html className="theme" lang="fr">
        <head>
          <HeadContent />
        </head>
        <body data-shell="application">
          {children}
          <Scripts />
        </body>
      </html>
    ));
  const pageTerminal = defineRoute()
    .config({ layout: rootTerminal, mode: "ssr" })
    .loader(() => ({}))
    .head(() => ({ meta: [{ title: "Document route" }] }))
    .page(() => <main>Rendered once</main>);
  const app = createDocumentApp({
    mode: "ssr",
    pageTerminal,
    pattern: "/",
    rootTerminal,
  });

  const response = await app.handle(new Request("http://localhost/"));
  const html = await response.text();

  expect(response.status).toBe(200);
  expect(html.match(/<!DOCTYPE html>/g)).toHaveLength(1);
  expect(html.match(/<html/g)).toHaveLength(1);
  expect(html.match(/<body/g)).toHaveLength(1);
  expect(html).toContain('<html class="theme" lang="fr">');
  expect(html).toContain('<body data-shell="application">');
  expect(html).toContain("<title>Document route</title>");
  expect(html).toContain("<main>Rendered once</main>");
  expect(html).not.toContain('id="root"');
});

test("the root layout owns the not-found document", async () => {
  const rootTerminal = defineRootRoute()
    .config({ mode: "ssr" })
    .layout(({ children }) => (
      <html lang="fr">
        <head>
          <HeadContent />
        </head>
        <body data-shell="not-found">
          {children}
          <Scripts />
        </body>
      </html>
    ));
  const root = {
    path: "/root.tsx",
    route: adaptDefinedLayout(rootTerminal, undefined),
  } satisfies RootLayout;

  const response = await renderRootNotFound(
    root,
    new Request("http://localhost/missing"),
    undefined
  );
  const html = await response.text();

  expect(response.status).toBe(404);
  expect(html.match(/<!DOCTYPE html>/g)).toHaveLength(1);
  expect(html.match(/<html/g)).toHaveLength(1);
  expect(html).toContain('<body data-shell="not-found">');
  expect(html).toContain('id="__FURIN_DATA__"');
});

test("a broken root layout falls back to a complete document", async () => {
  const rootTerminal = defineRootRoute()
    .config({ mode: "ssr" })
    .layout(() => {
      throw new Error("root layout failed");
    });
  const pageTerminal = defineRoute()
    .config({ layout: rootTerminal, mode: "ssr" })
    .loader(() => ({}))
    .page(() => <main>unreachable</main>);
  const app = createDocumentApp({
    mode: "ssr",
    pageTerminal,
    pattern: "/",
    rootError: ({ error }) => <main data-fallback="root">{error.message}</main>,
    rootTerminal,
  });

  const response = await app.handle(new Request("http://localhost/"));
  const html = await response.text();

  expect(response.status).toBe(500);
  expect(html.match(/<!DOCTYPE html>/g)).toHaveLength(1);
  expect(html.match(/<html/g)).toHaveLength(1);
  expect(html.match(/<body/g)).toHaveLength(1);
  expect(html).toContain('<main data-fallback="root">An unexpected error occurred.</main>');
  expect(html).toContain('id="__FURIN_DATA__"');
});

test("a head failure is rendered inside the root document", async () => {
  const rootTerminal = defineRootRoute()
    .config({ mode: "ssr" })
    .layout(({ children }) => (
      <html lang="en">
        <head>
          <HeadContent />
        </head>
        <body>
          {children}
          <Scripts />
        </body>
      </html>
    ));
  const pageTerminal = defineRoute()
    .config({ layout: rootTerminal, mode: "ssr" })
    .loader(() => ({}))
    .head(() => {
      throw new Error("head failed");
    })
    .page(() => <main>unreachable</main>);
  const app = createDocumentApp({
    mode: "ssr",
    pageTerminal,
    pattern: "/",
    rootTerminal,
  });

  const response = await app.handle(new Request("http://localhost/"));
  const html = await response.text();

  expect(response.status).toBe(500);
  expect(html.match(/<!DOCTYPE html>/g)).toHaveLength(1);
  expect(html).toContain("Something went wrong");
  expect(html).toContain('id="__FURIN_DATA__"');
});

test("a root layout that does not render html is rejected as a document", async () => {
  const rootTerminal = defineRootRoute()
    .config({ mode: "ssr" })
    .layout(({ children }) => <main data-invalid-root="">{children}</main>);
  const pageTerminal = defineRoute()
    .config({ layout: rootTerminal, mode: "ssr" })
    .loader(() => ({}))
    .page(() => <p>invalid document content</p>);
  const app = createDocumentApp({
    mode: "ssr",
    pageTerminal,
    pattern: "/",
    rootTerminal,
  });

  const response = await app.handle(new Request("http://localhost/"));
  const html = await response.text();

  expect(response.status).toBe(500);
  expect(html.match(/<!DOCTYPE html>/g)).toHaveLength(1);
  expect(html).toContain("Something went wrong");
  expect(html).not.toContain("data-invalid-root");
});

test("an invalid ISR root document is not cached as a successful render", async () => {
  const rootTerminal = defineRootRoute()
    .config({ mode: "ssr" })
    .layout(({ children }) => <main data-invalid-root="">{children}</main>);
  const pageTerminal = defineRoute()
    .config({ layout: rootTerminal, mode: "isr", revalidate: 60 })
    .loader(() => ({}))
    .page(() => <p>invalid ISR content</p>);
  const app = createDocumentApp({
    mode: "isr",
    pageTerminal,
    pattern: "/isr",
    rootTerminal,
  });

  const first = await app.handle(new Request("http://localhost/isr"));
  const second = await app.handle(new Request("http://localhost/isr"));
  const html = await second.text();

  expect(first.status).toBe(500);
  expect(second.status).toBe(500);
  expect(html).toContain("Something went wrong");
  expect(html).not.toContain("invalid ISR content");
});

test("a root document without Scripts is rejected", async () => {
  const rootTerminal = defineRootRoute()
    .config({ mode: "ssr" })
    .layout(({ children }) => (
      <html lang="en">
        <head>
          <HeadContent />
        </head>
        <body>{children}</body>
      </html>
    ));
  const pageTerminal = defineRoute()
    .config({ layout: rootTerminal, mode: "ssr" })
    .loader(() => ({}))
    .page(() => <p>missing scripts</p>);
  const app = createDocumentApp({
    mode: "ssr",
    pageTerminal,
    pattern: "/",
    rootTerminal,
  });

  const response = await app.handle(new Request("http://localhost/"));
  const html = await response.text();

  expect(response.status).toBe(500);
  expect(html).toContain("Something went wrong");
  expect(html).not.toContain("missing scripts");
});

test("a root document without HeadContent is rejected", async () => {
  const rootTerminal = defineRootRoute()
    .config({ mode: "ssr" })
    .layout(({ children }) => (
      <html lang="en">
        <head />
        <body>
          {children}
          <Scripts />
        </body>
      </html>
    ));
  const pageTerminal = defineRoute()
    .config({ layout: rootTerminal, mode: "ssr" })
    .loader(() => ({}))
    .page(() => <p>missing head content</p>);
  const app = createDocumentApp({
    mode: "ssr",
    pageTerminal,
    pattern: "/",
    rootTerminal,
  });

  const response = await app.handle(new Request("http://localhost/"));
  const html = await response.text();

  expect(response.status).toBe(500);
  expect(html).toContain("Something went wrong");
  expect(html).not.toContain("missing head content");
});
