/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { toCrossJSON } from "seroval";
import { Link, RouterProvider } from "../../src/link";
import type { ClientRoute } from "../../src/router-provider";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePage(linkTo: string): React.ComponentType<Record<string, unknown>> {
  return () =>
    createElement(
      "div",
      { style: { height: "2000px" } },
      createElement(Link, { to: linkTo }, `Go to ${linkTo}`)
    );
}

function makeRoute(path: string, linkTo: string): ClientRoute {
  return {
    pattern: path,
    regex: new RegExp(`^${path}$`),
    load: async () => ({
      default: {
        component: makePage(linkTo),
        _route: { __type: "FURIN_ROUTE" } as never,
      },
    }),
  };
}

/** Returns a single-line NDJSON response (CrossJSON-serialised) for the /_furin/data endpoint. */
function makeNdjsonResponse(data: Record<string, unknown>): Response {
  const ndjson = JSON.stringify(toCrossJSON(data));
  return new Response(ndjson, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
}

interface RenderRouterResult {
  cleanup: () => void;
  container: HTMLDivElement;
  root: Root;
}

async function renderRouterWithLink(
  routes: ClientRoute[],
  initialPath: string | undefined
): Promise<RenderRouterResult> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const win = globalThis as unknown as Window & typeof globalThis;
  const path = initialPath ?? "/";
  win.location.href = `http://localhost:3000${path}`;
  win.history.replaceState(null, "", path);

  let initialMatch:
    | (ClientRoute & {
        component: React.ComponentType<Record<string, unknown>>;
        pageRoute: unknown;
      })
    | null = null;
  const rawMatch = routes.find((r) => r.regex.test(path));
  if (rawMatch) {
    const mod = await rawMatch.load();
    initialMatch = {
      ...rawMatch,
      component: mod.default.component,
      pageRoute: mod.default._route,
    };
  }

  flushSync(() => {
    root.render(
      createElement(RouterProvider, {
        routes,
        root: null,
        initialMatch,
        initialData: {},
        initialDigest: undefined,
        initialNotFound: undefined,
        autoRefresh: true,
        basePath: "",
        defaultPreload: "intent",
        defaultPreloadDelay: 50,
        defaultPreloadStaleTime: 30_000,
        prefetchCacheSize: 50,
      } as any)
    );
  });

  return {
    container,
    root,
    cleanup: () => {
      flushSync(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RouterProvider click interception", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalPushState: typeof window.history.pushState;
  let pushStateCalls: Array<{ url: string }> = [];
  let currentCleanup: (() => void) | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalPushState = window.history.pushState;
    pushStateCalls = [];
    currentCleanup = undefined;

    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = new URL(input.toString(), window.location.origin);
      const logicalPath =
        url.pathname === "/_furin/data" ? (url.searchParams.get("path") ?? "") : url.pathname;

      if (logicalPath === "/page-b") {
        return Promise.resolve(makeNdjsonResponse({ message: "page-b" }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof globalThis.fetch;

    window.history.pushState = mock(
      (_state: unknown, _unused: string, url?: string | URL | null) => {
        if (url) {
          pushStateCalls.push({ url: String(url) });
          const win = globalThis as unknown as Window & typeof globalThis;
          win.location.href = `http://localhost:3000${url}`;
        }
      }
    ) as typeof window.history.pushState;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    window.history.pushState = originalPushState;
    currentCleanup?.();
    currentCleanup = undefined;
  });

  test("click on Furin Link triggers history.pushState exactly once", async () => {
    const routes = [makeRoute("/page-a", "/page-b"), makeRoute("/page-b", "/page-a")];
    const { container, cleanup } = await renderRouterWithLink(routes, "/page-a");
    currentCleanup = cleanup;

    const anchor = container.querySelector("a") as HTMLAnchorElement;
    expect(anchor).not.toBeNull();

    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // Wait deterministically for pushState to be called
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (pushStateCalls.length === 1 || window.location.pathname === "/page-b") {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - start > 2000) {
          clearInterval(interval);
          reject(new Error("Timed out waiting for navigation"));
        }
      }, 10);
    });

    expect(pushStateCalls.length).toBe(1);
    expect(pushStateCalls[0]?.url).toBe("/page-b");
  });
});
