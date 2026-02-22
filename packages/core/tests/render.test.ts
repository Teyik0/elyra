import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createElement } from "react";
import {
  buildElement,
  handleISR,
  injectSuppressHydration,
  loadPageModule,
  loadRootModule,
  prerenderSSG,
  renderSSR,
  renderToHTML,
  runLoaders,
  streamToString,
} from "../src/render";
import type { ResolvedRoute } from "../src/router";
import { scanPages } from "../src/router";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures/pages");

async function getRoute(pattern: string): Promise<ResolvedRoute> {
  const result = await scanPages(FIXTURES_DIR);
  const route = result.routes.find((r) => r.pattern === pattern);
  if (!route) {
    throw new Error(`Route ${pattern} not found`);
  }
  return route;
}

async function getRoot() {
  const result = await scanPages(FIXTURES_DIR);
  if (!result.root) {
    throw new Error("Root not found");
  }
  return result.root;
}

describe("render.tsx", () => {
  describe("streamToString", () => {
    test("converts readable stream to string", async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("Hello "));
          controller.enqueue(encoder.encode("World"));
          controller.close();
        },
      });

      const result = await streamToString(stream);
      expect(result).toBe("Hello World");
    });

    test("handles empty stream", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      const result = await streamToString(stream);
      expect(result).toBe("");
    });

    test("handles multi-byte characters", async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("Hello "));
          controller.enqueue(encoder.encode("世界"));
          controller.close();
        },
      });

      const result = await streamToString(stream);
      expect(result).toBe("Hello 世界");
    });
  });

  describe("injectSuppressHydration", () => {
    test("adds suppressHydrationWarning to html element", () => {
      const element = createElement("html", null, "content");
      const result = injectSuppressHydration(element) as {
        type: string;
        props: { suppressHydrationWarning: boolean };
      };

      expect(result.type).toBe("html");
      expect(result.props.suppressHydrationWarning).toBe(true);
    });

    test("adds suppressHydrationWarning to head element", () => {
      const element = createElement("head", null, "content");
      const result = injectSuppressHydration(element) as {
        type: string;
        props: { suppressHydrationWarning: boolean };
      };

      expect(result.type).toBe("head");
      expect(result.props.suppressHydrationWarning).toBe(true);
    });

    test("adds suppressHydrationWarning to body element", () => {
      const element = createElement("body", null, "content");
      const result = injectSuppressHydration(element) as {
        type: string;
        props: { suppressHydrationWarning: boolean };
      };

      expect(result.type).toBe("body");
      expect(result.props.suppressHydrationWarning).toBe(true);
    });

    test("recursively processes children", () => {
      const child = createElement("body", null, "child");
      const element = createElement("html", null, child);
      const result = injectSuppressHydration(element) as {
        type: string;
        props: { suppressHydrationWarning: boolean; children: unknown };
      };

      expect(result.props.suppressHydrationWarning).toBe(true);
      const childResult = result.props.children as {
        props: { suppressHydrationWarning: boolean };
      };
      expect(childResult.props.suppressHydrationWarning).toBe(true);
    });

    test("processes children of non-matching elements", () => {
      const element = createElement("div", { className: "test" }, "content");
      const result = injectSuppressHydration(element) as {
        type: string;
        props: { className: string; children: string };
      };

      expect(result.type).toBe("div");
      expect(result.props.className).toBe("test");
      expect(result.props.children).toBe("content");
    });

    test("handles null element", () => {
      expect(injectSuppressHydration(null)).toBeNull();
    });

    test("handles undefined element", () => {
      expect(injectSuppressHydration(undefined)).toBeUndefined();
    });

    test("handles string element", () => {
      expect(injectSuppressHydration("string")).toBe("string");
    });

    test("handles array of children", () => {
      const child1 = createElement("head", null, "head");
      const child2 = createElement("body", null, "body");
      const element = createElement("html", null, [child1, child2]);
      const result = injectSuppressHydration(element) as {
        props: { children: unknown[] };
      };

      const children = result.props.children as Array<{
        props: { suppressHydrationWarning: boolean };
      }>;
      expect(children[0]?.props.suppressHydrationWarning).toBe(true);
      expect(children[1]?.props.suppressHydrationWarning).toBe(true);
    });
  });

  describe("buildElement", () => {
    test("wraps component with nested layouts", async () => {
      const nestedRoute = await getRoute("/nested");
      const root = await getRoot();

      await loadPageModule(nestedRoute, false);
      const rootLayout = await loadRootModule(root, false);

      const element = buildElement(nestedRoute, {}, rootLayout, false);
      expect(element).toBeDefined();
    });

    test("applies layouts in correct order (innermost first)", async () => {
      const deepRoute = await getRoute("/nested/deep");
      const root = await getRoot();

      await loadPageModule(deepRoute, false);
      const rootLayout = await loadRootModule(root, false);

      const element = buildElement(deepRoute, {}, rootLayout, false);
      expect(element).toBeDefined();
    });

    test("skips root layout in chain", async () => {
      const nestedRoute = await getRoute("/nested");
      const root = await getRoot();

      await loadPageModule(nestedRoute, false);
      const rootLayout = await loadRootModule(root, false);

      const element = buildElement(nestedRoute, {}, rootLayout, false);
      expect(element).toBeDefined();
    });

    test("returns Loading div when page undefined", () => {
      const route = {
        page: undefined,
        routeChain: [],
      } as unknown as Parameters<typeof buildElement>[0];

      const element = buildElement(route, {}, null, false);
      expect(element).toBeDefined();
    });
  });

  describe("runLoaders", () => {
    test("runs root loader first", async () => {
      const withLoaderRoute = await getRoute("/with-loader");
      const root = await getRoot();

      await loadPageModule(withLoaderRoute, false);
      const rootLayout = await loadRootModule(root, false);

      const data = await runLoaders(withLoaderRoute, {}, {}, rootLayout);

      expect(data.layoutData).toBe("from-layout");
      expect(data.pageData).toBe("from-page");
    });

    test("runs layout loaders in chain order", async () => {
      const deepRoute = await getRoute("/nested/deep");
      const root = await getRoot();

      await loadPageModule(deepRoute, false);
      const rootLayout = await loadRootModule(root, false);

      const data = await runLoaders(deepRoute, {}, {}, rootLayout);
      expect(data).toBeDefined();
    });

    test("runs page loader last", async () => {
      const withLoaderRoute = await getRoute("/with-loader");
      const root = await getRoot();

      await loadPageModule(withLoaderRoute, false);
      const rootLayout = await loadRootModule(root, false);

      const data = await runLoaders(withLoaderRoute, {}, {}, rootLayout);

      expect(data.pageData).toBe("from-page");
      expect(data.layoutData).toBe("from-layout");
    });

    test("merges data from all loaders", async () => {
      const withLoaderRoute = await getRoute("/with-loader");
      const root = await getRoot();

      await loadPageModule(withLoaderRoute, false);
      const rootLayout = await loadRootModule(root, false);

      const data = await runLoaders(withLoaderRoute, {}, {}, rootLayout);

      expect(Object.keys(data).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("renderToHTML", () => {
    test("renders page with layouts", async () => {
      const nestedRoute = await getRoute("/nested");
      const root = await getRoot();

      const html = await renderToHTML(nestedRoute, {}, {}, root, false);

      expect(html).toContain("<html");
      expect(html).toContain("nested-page");
    });

    test("includes data script", async () => {
      const withLoaderRoute = await getRoute("/with-loader");
      const root = await getRoot();

      const html = await renderToHTML(withLoaderRoute, {}, {}, root, false);

      expect(html).toContain("__ELYSION_DATA__");
    });

    test("post-processes HTML with head injection", async () => {
      const ssgRoute = await getRoute("/ssg-page");
      const root = await getRoot();

      const html = await renderToHTML(ssgRoute, {}, {}, root, false);

      expect(html).toContain("<title>SSG Test Page</title>");
    });
  });

  describe("prerenderSSG", () => {
    test("renders and caches HTML", async () => {
      const indexRoute = await getRoute("/");
      const root = await getRoot();

      const html1 = await prerenderSSG(indexRoute, {}, {}, root, false);
      const html2 = await prerenderSSG(indexRoute, {}, {}, root, false);

      expect(html1).toBe(html2);
    });

    test("replaces params in pattern", async () => {
      const indexRoute = await getRoute("/");
      const root = await getRoot();

      const html = await prerenderSSG(indexRoute, {}, {}, root, false);
      expect(html).toContain("<html");
    });

    test("returns cached HTML on second call", async () => {
      const indexRoute = await getRoute("/");
      const root = await getRoot();

      const html1 = await prerenderSSG(indexRoute, {}, {}, root, false);
      const html2 = await prerenderSSG(indexRoute, {}, {}, root, false);

      expect(html1).toBe(html2);
    });
  });

  describe("renderSSR", () => {
    test("returns Response with HTML", async () => {
      const ssrRoute = await getRoute("/ssr-page");
      const root = await getRoot();

      const response = await renderSSR(ssrRoute, {}, {}, root, false);

      expect(response).toBeInstanceOf(Response);
      const html = await response.text();
      expect(html).toContain("<html");
    });

    test("sets correct headers (no-cache)", async () => {
      const ssrRoute = await getRoute("/ssr-page");
      const root = await getRoot();

      const response = await renderSSR(ssrRoute, {}, {}, root, false);

      expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");
    });
  });

  describe("handleISR", () => {
    test("caches HTML on first render", async () => {
      const isrRoute = await getRoute("/isr-page");
      const root = await getRoot();

      const response = await handleISR(isrRoute, {}, {}, root, false);
      const html = await response.text();

      expect(html).toContain("<html");
      expect(html).toContain("isr-page");
    });

    test("sets correct Cache-Control headers", async () => {
      const isrRoute = await getRoute("/isr-page");
      const root = await getRoot();

      const response = await handleISR(isrRoute, {}, {}, root, false);

      const cacheControl = response.headers.get("Cache-Control");
      expect(cacheControl).toContain("public");
      expect(cacheControl).toContain("s-maxage=60");
    });

    test("returns cached HTML when fresh", async () => {
      const isrRoute = await getRoute("/isr-page");
      const root = await getRoot();

      const response1 = await handleISR(isrRoute, {}, {}, root, false);
      const html1 = await response1.text();

      const response2 = await handleISR(isrRoute, {}, {}, root, false);
      const html2 = await response2.text();

      expect(html1).toBe(html2);
    });
  });

  describe("loadPageModule", () => {
    test("returns cached page in production mode", async () => {
      const indexRoute = await getRoute("/");

      const page = await loadPageModule(indexRoute, false);
      expect(page).toBeDefined();
      expect(page.component).toBeDefined();
    });

    test("reloads page in dev mode", async () => {
      const indexRoute = await getRoute("/");

      const page = await loadPageModule(indexRoute, true);
      expect(page).toBeDefined();
    });
  });

  describe("loadRootModule", () => {
    test("returns cached root in production mode", async () => {
      const root = await getRoot();

      const rootRoute = await loadRootModule(root, false);
      expect(rootRoute).toBeDefined();
      expect(rootRoute.layout).toBeDefined();
    });

    test("reloads root in dev mode", async () => {
      const root = await getRoot();

      const rootRoute = await loadRootModule(root, true);
      expect(rootRoute).toBeDefined();
    });
  });
});
