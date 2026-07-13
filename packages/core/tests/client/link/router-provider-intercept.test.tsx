/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { log } from "evlog";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toCrossJSON } from "seroval";
import { Link, RouterProvider } from "../../../src/client/link.tsx";
import type { ClientRoute } from "../../../src/client/router/index.ts";
import { installDom, resetDomState, uninstallDom } from "../../support/dom.ts";

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
    load: async () => ({
      default: {
        _route: { __type: "FURIN_ROUTE" } as never,
        component: makePage(linkTo),
      },
    }),
    pattern: path,
    regex: new RegExp(`^${path}$`),
  };
}

async function dispatchReactEvent(target: EventTarget, event: Event): Promise<void> {
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
  });
}

async function flushReactUpdates(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Returns a single-line NDJSON response (CrossJSON-serialised) for the /_furin/data endpoint. */
function makeNdjsonResponse(data: Record<string, unknown>): Response {
  const ndjson = JSON.stringify(toCrossJSON(data));
  return new Response(ndjson, { headers: { "Content-Type": "application/x-ndjson" }, status: 200 });
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

  await act(() => {
    root.render(
      createElement(RouterProvider, {
        autoRefresh: true,
        basePath: "",
        defaultPreload: "intent",
        defaultPreloadDelay: 50,
        defaultPreloadStaleTime: 30_000,
        initialData: {},
        initialDigest: undefined,
        initialMatch,
        initialNotFound: undefined,
        prefetchCacheSize: 50,
        root: null,
        routes,
      } as any)
    );
  });

  return {
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
    container,
    root,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RouterProvider click interception", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalPushState: typeof window.history.pushState | undefined;
  let pushStateCalls: Array<{ url: string }> = [];
  let currentCleanup: (() => void) | undefined;
  let abortFirstPageBRequest = false;
  let pageBRequests = 0;

  beforeEach(() => {
    installDom();
    resetDomState();
    originalFetch = globalThis.fetch;
    originalPushState =
      typeof window !== "undefined" && typeof window.history !== "undefined"
        ? window.history.pushState
        : undefined;
    pushStateCalls = [];
    currentCleanup = undefined;
    abortFirstPageBRequest = false;
    pageBRequests = 0;

    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString(), window.location.origin);
      const logicalPath =
        url.pathname === "/_furin/data" ? (url.searchParams.get("path") ?? "") : url.pathname;

      if (logicalPath === "/page-b") {
        pageBRequests += 1;
        if (abortFirstPageBRequest && pageBRequests === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                const error = new Error("signal is aborted without reason");
                error.name = "AbortError";
                reject(error);
              },
              { once: true }
            );
          });
        }
        return Promise.resolve(makeNdjsonResponse({ message: "page-b" }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof globalThis.fetch;

    if (typeof window !== "undefined" && typeof window.history !== "undefined") {
      (window as Window & { history: History }).history.pushState = mock(
        (_state: unknown, _unused: string, url?: string | URL | null) => {
          if (url) {
            pushStateCalls.push({ url: String(url) });
            const win = globalThis as unknown as Window & typeof globalThis;
            win.location.href = `http://localhost:3000${url}`;
          }
        }
      ) as typeof window.history.pushState;
    }
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalPushState) {
      window.history.pushState = originalPushState;
    }
    currentCleanup?.();
    currentCleanup = undefined;
    await uninstallDom();
  });

  test("click on Furin Link triggers history.pushState exactly once", async () => {
    const routes = [makeRoute("/page-a", "/page-b"), makeRoute("/page-b", "/page-a")];
    const { container, cleanup } = await renderRouterWithLink(routes, "/page-a");
    currentCleanup = cleanup;

    const anchor = container.querySelector("a") as HTMLAnchorElement;
    expect(anchor).not.toBeNull();

    await dispatchReactEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true }));

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
    await flushReactUpdates();

    expect(pushStateCalls.length).toBe(1);
    expect(pushStateCalls[0]?.url).toBe("/page-b");
  });

  test("superseding a Link navigation does not leak an AbortError", async () => {
    const errorLog = spyOn(log, "error");
    const waitFor = (condition: () => boolean) =>
      new Promise<void>((resolve, reject) => {
        const startedAt = Date.now();
        const interval = setInterval(() => {
          if (condition()) {
            clearInterval(interval);
            resolve();
          } else if (Date.now() - startedAt > 2000) {
            clearInterval(interval);
            reject(new Error("Timed out waiting for navigation"));
          }
        }, 10);
      });

    try {
      abortFirstPageBRequest = true;
      const routes = [makeRoute("/page-a", "/page-b"), makeRoute("/page-b", "/page-a")];
      const { container, cleanup } = await renderRouterWithLink(routes, "/page-a");
      currentCleanup = cleanup;
      const anchor = container.querySelector("a") as HTMLAnchorElement;

      await dispatchReactEvent(
        anchor,
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
      await waitFor(() => pageBRequests === 1);
      await dispatchReactEvent(
        anchor,
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
      await waitFor(() => pageBRequests === 2 && window.location.pathname === "/page-b");
      await flushReactUpdates();

      expect(pageBRequests).toBe(2);
      expect(window.location.pathname).toBe("/page-b");
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });
});
