import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Link, RouterContext, type RouterContextValue, SSR_FALLBACK_ROUTER } from "../../src/link";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRouterContext(overrides: Partial<RouterContextValue> | undefined): RouterContextValue {
  return {
    basePath: "",
    currentHref: "/",
    navigate: () => Promise.resolve(),
    prefetch: () => {
      /* noop */
    },
    invalidatePrefetch: () => {
      /* noop */
    },
    refresh: () => Promise.resolve(),
    isNavigating: false,
    defaultPreload: "intent",
    defaultPreloadDelay: 50,
    defaultPreloadStaleTime: 30_000,
    ...(overrides ?? {}),
  };
}

interface RenderResult {
  anchor: HTMLAnchorElement;
  cleanup: () => void;
  container: HTMLDivElement;
  root: Root;
}

function renderLink(
  element: React.ReactElement,
  ctx: RouterContextValue | undefined
): RenderResult {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const wrapped = ctx ? createElement(RouterContext.Provider, { value: ctx }, element) : element;

  flushSync(() => {
    root.render(wrapped);
  });

  const anchor = container.querySelector("a") as HTMLAnchorElement;

  return {
    container,
    root,
    anchor,
    cleanup: () => {
      flushSync(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

// ── Mock IntersectionObserver ─────────────────────────────────────────────────

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];

  callback: IntersectionObserverCallback;
  elements: Element[] = [];

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.elements.push(element);
  }

  disconnect(): void {
    this.elements = [];
  }

  trigger(isIntersecting: boolean): void {
    const entries = this.elements.map((target) => ({
      isIntersecting,
      target,
      boundingClientRect: {} as DOMRectReadOnly,
      intersectionRatio: isIntersecting ? 1 : 0,
      intersectionRect: {} as DOMRectReadOnly,
      rootBounds: null,
      time: Date.now(),
    }));
    this.callback(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }

  static cleanup(): void {
    MockIntersectionObserver.instances = [];
  }
}

const OriginalIntersectionObserver = globalThis.IntersectionObserver;

// ── SSR path ──────────────────────────────────────────────────────────────────

describe("Link SSR path", () => {
  test("renders via RouterContext.Consumer when window is undefined", () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error: intentionally removing window for SSR branch coverage
    globalThis.window = undefined;

    try {
      const html = renderToStaticMarkup(createElement(Link, { to: "/blog" }, "Blog"));
      expect(html).toBe('<a href="/blog" data-furin-link="true">Blog</a>');
    } finally {
      globalThis.window = originalWindow;
    }
  });

  test("SSR_FALLBACK_ROUTER methods are safe no-ops", async () => {
    expect(await SSR_FALLBACK_ROUTER.navigate("/")).toBe(undefined);
    expect(SSR_FALLBACK_ROUTER.prefetch("/")).toBe(undefined);
    expect(SSR_FALLBACK_ROUTER.invalidatePrefetch("/")).toBe(undefined);
    expect(await SSR_FALLBACK_ROUTER.refresh()).toBe(undefined);
  });

  test("SSR: uses basePath from RouterContext.Provider", () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error: intentionally removing window for SSR branch coverage
    globalThis.window = undefined;

    try {
      const html = renderToStaticMarkup(
        createElement(
          RouterContext.Provider,
          {
            value: {
              basePath: "/furin",
              currentHref: "/docs",
              navigate: () => Promise.resolve(),
              prefetch: () => {
                /* noop */
              },
              invalidatePrefetch: () => {
                /* noop */
              },
              refresh: () => Promise.resolve(),
              isNavigating: false,
              defaultPreload: "intent",
              defaultPreloadDelay: 50,
              defaultPreloadStaleTime: 30_000,
            },
          },
          createElement(Link, { to: "/docs" }, "Docs")
        )
      );
      expect(html).toBe(
        '<a href="/furin/docs" data-furin-link="true" data-status="active">Docs</a>'
      );
    } finally {
      globalThis.window = originalWindow;
    }
  });

  test("SSR: search and hash are appended", () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error: intentionally removing window for SSR branch coverage
    globalThis.window = undefined;

    try {
      const html = renderToStaticMarkup(
        createElement(Link, { to: "/blog", search: { page: 2 }, hash: "comments" }, "Blog")
      );
      expect(html).toBe('<a href="/blog?page=2#comments" data-furin-link="true">Blog</a>');
    } finally {
      globalThis.window = originalWindow;
    }
  });

  test("SSR: aria-disabled when disabled", () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error: intentionally removing window for SSR branch coverage
    globalThis.window = undefined;

    try {
      const html = renderToStaticMarkup(
        createElement(Link, { to: "/about", disabled: true }, "About")
      );
      expect(html).toBe('<a href="/about" data-furin-link="true" aria-disabled="true">About</a>');
    } finally {
      globalThis.window = originalWindow;
    }
  });

  test("SSR: children as render function", () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error: intentionally removing window for SSR branch coverage
    globalThis.window = undefined;

    try {
      const html = renderToStaticMarkup(
        createElement(Link, {
          to: "/",
          // biome-ignore lint/correctness/noChildrenProp: function-children must be passed via props
          children: ({ isActive }: { isActive: boolean }) =>
            createElement("span", { "data-active": String(isActive) }, "Home"),
        })
      );
      expect(html).toContain('data-active="true"');
    } finally {
      globalThis.window = originalWindow;
    }
  });

  test("SSR: activeProps merged when active", () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error: intentionally removing window for SSR branch coverage
    globalThis.window = undefined;

    try {
      const html = renderToStaticMarkup(
        createElement(
          RouterContext.Provider,
          {
            value: {
              basePath: "",
              currentHref: "/",
              navigate: () => Promise.resolve(),
              prefetch: () => {
                /* noop */
              },
              invalidatePrefetch: () => {
                /* noop */
              },
              refresh: () => Promise.resolve(),
              isNavigating: false,
              defaultPreload: "intent",
              defaultPreloadDelay: 50,
              defaultPreloadStaleTime: 30_000,
            },
          },
          createElement(
            Link,
            {
              to: "/",
              activeProps: ({ isActive }) => (isActive ? { className: "active-link" } : {}),
            },
            "Home"
          )
        )
      );
      expect(html).toContain('class="active-link"');
      expect(html).toContain('data-status="active"');
    } finally {
      globalThis.window = originalWindow;
    }
  });

  test("SSR: inactiveProps merged when inactive", () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error: intentionally removing window for SSR branch coverage
    globalThis.window = undefined;

    try {
      const html = renderToStaticMarkup(
        createElement(
          RouterContext.Provider,
          {
            value: {
              basePath: "",
              currentHref: "/other",
              navigate: () => Promise.resolve(),
              prefetch: () => {
                /* noop */
              },
              invalidatePrefetch: () => {
                /* noop */
              },
              refresh: () => Promise.resolve(),
              isNavigating: false,
              defaultPreload: "intent",
              defaultPreloadDelay: 50,
              defaultPreloadStaleTime: 30_000,
            },
          },
          createElement(
            Link,
            {
              to: "/blog",
              inactiveProps: () => ({ className: "muted-link" }),
            },
            "Blog"
          )
        )
      );
      expect(html).toContain('class="muted-link"');
      expect(html).not.toContain("data-status");
    } finally {
      globalThis.window = originalWindow;
    }
  });

  test("SSR: ignores spurious href prop so basePath is preserved", () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error: intentionally removing window for SSR branch coverage
    globalThis.window = undefined;

    try {
      const html = renderToStaticMarkup(
        createElement(
          RouterContext.Provider,
          {
            value: {
              basePath: "/furin",
              currentHref: "/",
              navigate: () => Promise.resolve(),
              prefetch: () => {
                /* noop */
              },
              invalidatePrefetch: () => {
                /* noop */
              },
              refresh: () => Promise.resolve(),
              isNavigating: false,
              defaultPreload: "intent",
              defaultPreloadDelay: 50,
              defaultPreloadStaleTime: 30_000,
            },
          },
          createElement(
            Link,
            {
              to: "/blog",
              href: "/blog",
            } as any,
            "Blog"
          )
        )
      );
      expect(html).toBe('<a href="/furin/blog" data-furin-link="true">Blog</a>');
    } finally {
      globalThis.window = originalWindow;
    }
  });
});

// ── LinkInteractive (client) ──────────────────────────────────────────────────

describe("LinkInteractive — client-side behaviour", () => {
  let originalOpen: typeof window.open | undefined;
  let originalHrefDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    MockIntersectionObserver.cleanup();
    globalThis.IntersectionObserver =
      MockIntersectionObserver as unknown as typeof IntersectionObserver;

    // happy-dom navigates on <a> clicks when preventDefault() is not called.
    // That async navigation loads stylesheets/scripts that throw uncaught
    // errors (missing SyntaxError, disabled module loading, etc.) and bleed
    // into the next test. We stub window.open so browser-level navigation
    // is suppressed while React handlers still run for SPA routing asserts.
    originalOpen =
      typeof window !== "undefined" && typeof window.open !== "undefined" ? window.open : undefined;
    if (typeof window !== "undefined") {
      (window as Window & { open?: typeof window.open }).open = () => null;
    }

    // Also freeze window.location.href so happy-dom can't navigate away
    // on anchor clicks — React's synthetic-event preventDefault() doesn't
    // reliably stop native navigation in happy-dom.
    originalHrefDescriptor =
      typeof window !== "undefined" && typeof window.location !== "undefined"
        ? Object.getOwnPropertyDescriptor(window.location, "href")
        : undefined;
    Object.defineProperty(window.location, "href", {
      configurable: true,
      get: () => "http://localhost:3000/",
      set: () => {
        /* no-op */
      },
    });
  });

  afterEach(() => {
    globalThis.IntersectionObserver = OriginalIntersectionObserver;
    MockIntersectionObserver.cleanup();
    if (originalOpen && typeof window !== "undefined") {
      window.open = originalOpen;
    }
    if (typeof window !== "undefined" && typeof window.location !== "undefined") {
      if (originalHrefDescriptor) {
        Object.defineProperty(window.location, "href", originalHrefDescriptor);
      } else {
        // href lives on the Location prototype — delete our own-property override
        // biome-ignore lint/performance/noDelete: removing an own property to restore prototype accessor behavior
        delete (window.location as unknown as Record<string, unknown>).href;
      }
    }
  });

  // ── Rendering ───────────────────────────────────────────────────────────────

  test("renders an anchor with correct href", () => {
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), undefined);
    expect(anchor.tagName).toBe("A");
    expect(anchor.getAttribute("href")).toBe("/blog");
    expect(anchor.textContent).toBe("Blog");
    cleanup();
  });

  test("includes basePath in the physical href", () => {
    const ctx = makeRouterContext({ basePath: "/furin" });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/docs" }, "Docs"), ctx);
    expect(anchor.getAttribute("href")).toBe("/furin/docs");
    cleanup();
  });

  test("appends search and hash to href", () => {
    const ctx = makeRouterContext(undefined);
    const { anchor, cleanup } = renderLink(
      createElement(Link, { to: "/blog", search: { page: 2 }, hash: "comments" }, "Blog"),
      ctx
    );
    expect(anchor.getAttribute("href")).toBe("/blog?page=2#comments");
    cleanup();
  });

  test("data-status='active' when currentHref matches logical path", () => {
    const ctx = makeRouterContext({ currentHref: "/blog" });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), ctx);
    expect(anchor.getAttribute("data-status")).toBe("active");
    cleanup();
  });

  test("no data-status when link is inactive", () => {
    const ctx = makeRouterContext({ currentHref: "/other" });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), ctx);
    expect(anchor.hasAttribute("data-status")).toBe(false);
    cleanup();
  });

  test("aria-disabled when disabled", () => {
    const { anchor, cleanup } = renderLink(
      createElement(Link, { to: "/about", disabled: true }, "About"),
      undefined
    );
    expect(anchor.getAttribute("aria-disabled")).toBe("true");
    cleanup();
  });

  test("children as render function receives isActive", () => {
    const ctx = makeRouterContext({ currentHref: "/active" });
    const { container, cleanup } = renderLink(
      createElement(Link, {
        to: "/active",
        // biome-ignore lint/correctness/noChildrenProp: function-children must be passed via props
        children: ({ isActive }: { isActive: boolean }) =>
          createElement("span", { "data-active": String(isActive) }),
      }),
      ctx
    );
    const span = container.querySelector("span");
    expect(span?.getAttribute("data-active")).toBe("true");
    cleanup();
  });

  test("activeProps merged when active", () => {
    const ctx = makeRouterContext({ currentHref: "/" });
    const { anchor, cleanup } = renderLink(
      createElement(
        Link,
        {
          to: "/",
          activeProps: ({ isActive }) => (isActive ? { className: "active-link" } : {}),
        },
        "Home"
      ),
      ctx
    );
    expect(anchor.className).toBe("active-link");
    cleanup();
  });

  test("inactiveProps merged when inactive", () => {
    const ctx = makeRouterContext({ currentHref: "/other" });
    const { anchor, cleanup } = renderLink(
      createElement(
        Link,
        {
          to: "/blog",
          inactiveProps: () => ({ className: "muted-link" }),
        },
        "Blog"
      ),
      ctx
    );
    expect(anchor.className).toBe("muted-link");
    cleanup();
  });

  // ── Click handling ──────────────────────────────────────────────────────────

  test("click navigates for internal link", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), ctx);

    console.log("CLICK TEST typeof window:", typeof window);
    const getListenerTypes = (el: any) => {
      const sym = Object.getOwnPropertySymbols(el).find(
        (s) => s.toString() === "Symbol(listeners)"
      );
      if (!sym) {
        return [];
      }
      const listeners = el[sym];
      return [...(listeners.capturing?.keys() || []), ...(listeners.bubbling?.keys() || [])];
    };
    console.log("CLICK TEST anchor types:", getListenerTypes(anchor).join(", ") || "none");
    console.log("CLICK TEST document types:", getListenerTypes(document).join(", ") || "none");
    console.log(
      "CLICK TEST container types:",
      getListenerTypes(anchor.parentElement).join(", ") || "none"
    );

    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(navigate).toHaveBeenCalledWith("/blog", { replace: undefined, resetScroll: true });
    cleanup();
  });

  test("click does not navigate when disabled", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { to: "/blog", disabled: true }, "Blog"),
      ctx
    );

    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(navigate).not.toHaveBeenCalled();
    cleanup();
  });

  test("click does not navigate with ctrl key", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), ctx);

    anchor.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })
    );

    expect(navigate).not.toHaveBeenCalled();
    cleanup();
  });

  test("click does not navigate with meta key", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), ctx);

    anchor.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true })
    );

    expect(navigate).not.toHaveBeenCalled();
    cleanup();
  });

  test("click does not navigate with shift key", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), ctx);

    anchor.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true })
    );

    expect(navigate).not.toHaveBeenCalled();
    cleanup();
  });

  test("click does not navigate with alt key", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), ctx);

    anchor.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true })
    );

    expect(navigate).not.toHaveBeenCalled();
    cleanup();
  });

  test("click does not navigate when target is _blank", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { to: "/blog", target: "_blank" }, "Blog"),
      ctx
    );

    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(navigate).not.toHaveBeenCalled();
    cleanup();
  });

  test("click does not navigate for external link", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { to: "https://example.com" }, "External"),
      ctx
    );

    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(navigate).not.toHaveBeenCalled();
    cleanup();
  });

  test("click does not navigate when href is unparseable", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "http://" }, "Broken"), ctx);

    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(navigate).not.toHaveBeenCalled();
    cleanup();
  });

  test("click calls custom onClick", () => {
    const onClick = mock<(e: React.MouseEvent<HTMLAnchorElement>) => void>(() => {
      /* noop */
    });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { to: "/blog", onClick }, "Blog"),
      undefined
    );

    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onClick).toHaveBeenCalled();
    cleanup();
  });

  test("click does not navigate if onClick calls preventDefault", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const onClick = (e: React.MouseEvent) => e.preventDefault();
    const { anchor, cleanup } = renderLink(
      createElement(Link, { to: "/blog", onClick }, "Blog"),
      ctx
    );

    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(navigate).not.toHaveBeenCalled();
    cleanup();
  });

  test("navigate passes replace option", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { to: "/blog", replace: true }, "Blog"),
      ctx
    );

    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(navigate).toHaveBeenCalledWith("/blog", { replace: true, resetScroll: true });
    cleanup();
  });

  test("navigate passes resetScroll=false", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { to: "/blog", resetScroll: false }, "Blog"),
      ctx
    );

    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(navigate).toHaveBeenCalledWith("/blog", { replace: undefined, resetScroll: false });
    cleanup();
  });

  // ── Prefetch: render ────────────────────────────────────────────────────────

  test('preload="render" triggers prefetch on mount', () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch });
    const { cleanup } = renderLink(
      createElement(Link, { to: "/blog", preload: "render" }, "Blog"),
      ctx
    );

    expect(prefetch).toHaveBeenCalledWith("/blog", { staleTime: 30_000 });
    cleanup();
  });

  test('preload="render" uses custom preloadStaleTime', () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch });
    const { cleanup } = renderLink(
      createElement(Link, { to: "/blog", preload: "render", preloadStaleTime: 5000 }, "Blog"),
      ctx
    );

    expect(prefetch).toHaveBeenCalledWith("/blog", { staleTime: 5000 });
    cleanup();
  });

  // ── Prefetch: viewport ──────────────────────────────────────────────────────

  test('preload="viewport" observes anchor with IntersectionObserver', () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch });
    const { cleanup } = renderLink(
      createElement(Link, { to: "/blog", preload: "viewport" }, "Blog"),
      ctx
    );

    expect(MockIntersectionObserver.instances.length).toBe(1);
    const instance = MockIntersectionObserver.instances[0] as MockIntersectionObserver;
    expect(instance.elements.length).toBe(1);
    cleanup();
  });

  test('preload="viewport" triggers prefetch when intersecting', () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch });
    const { cleanup } = renderLink(
      createElement(Link, { to: "/blog", preload: "viewport" }, "Blog"),
      ctx
    );

    const instance = MockIntersectionObserver.instances[0] as MockIntersectionObserver;
    instance.trigger(true);

    expect(prefetch).toHaveBeenCalledWith("/blog", { staleTime: 30_000 });
    cleanup();
  });

  test('preload="viewport" does not prefetch when not intersecting', () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch });
    const { cleanup } = renderLink(
      createElement(Link, { to: "/blog", preload: "viewport" }, "Blog"),
      ctx
    );

    const instance = MockIntersectionObserver.instances[0] as MockIntersectionObserver;
    instance.trigger(false);

    expect(prefetch).not.toHaveBeenCalled();
    cleanup();
  });

  test("preload=false does not set up viewport observer", () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch });
    const { cleanup } = renderLink(
      createElement(Link, { to: "/blog", preload: false }, "Blog"),
      ctx
    );

    expect(MockIntersectionObserver.instances.length).toBe(0);
    cleanup();
  });

  // ── Prefetch: intent (mouse enter / focus) ──────────────────────────────────

  test("mouse enter triggers intent prefetch after delay", async () => {
    const calls: Array<{ args: unknown[] }> = [];
    const prefetch = ((...args: unknown[]) => {
      calls.push({ args });
    }) as RouterContextValue["prefetch"];
    const ctx = makeRouterContext({ prefetch, defaultPreloadDelay: 10 });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), ctx);

    anchor.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })
    );

    expect(calls.length).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(1);
    const firstCall = calls[0];
    if (!firstCall) {
      throw new Error("Expected at least one prefetch call");
    }
    expect(firstCall.args).toEqual(["/blog", { staleTime: 30_000 }]);
    cleanup();
  });

  test("mouse enter does not prefetch when disabled", async () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch, defaultPreloadDelay: 10 });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { to: "/blog", disabled: true }, "Blog"),
      ctx
    );

    anchor.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(prefetch).not.toHaveBeenCalled();
    cleanup();
  });

  test("mouse enter does not prefetch for external link", async () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch, defaultPreloadDelay: 10 });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { to: "https://example.com" }, "External"),
      ctx
    );

    anchor.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(prefetch).not.toHaveBeenCalled();
    cleanup();
  });

  test("mouse enter does not prefetch when preload is not intent", async () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch, defaultPreloadDelay: 10 });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { to: "/blog", preload: false }, "Blog"),
      ctx
    );

    anchor.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(prefetch).not.toHaveBeenCalled();
    cleanup();
  });

  test("mouse leave cancels pending intent prefetch", async () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch, defaultPreloadDelay: 50 });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), ctx);

    anchor.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })
    );
    anchor.dispatchEvent(
      new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })
    );

    await new Promise((r) => setTimeout(r, 70));
    expect(prefetch).not.toHaveBeenCalled();
    cleanup();
  });

  test("focus triggers intent prefetch immediately", () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), ctx);

    anchor.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(prefetch).toHaveBeenCalledWith("/blog", { staleTime: 30_000 });
    cleanup();
  });

  test("focus does not prefetch when disabled", () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { to: "/blog", disabled: true }, "Blog"),
      ctx
    );

    anchor.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(prefetch).not.toHaveBeenCalled();
    cleanup();
  });

  test("focus does not prefetch for external link", () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { to: "https://example.com" }, "External"),
      ctx
    );

    anchor.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(prefetch).not.toHaveBeenCalled();
    cleanup();
  });

  test("focus does not prefetch when preload is not intent", () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { to: "/blog", preload: false }, "Blog"),
      ctx
    );

    anchor.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(prefetch).not.toHaveBeenCalled();
    cleanup();
  });

  test("mouse enter calls custom onMouseEnter", () => {
    const onMouseEnter = mock<(e: React.MouseEvent<HTMLAnchorElement>) => void>(() => {
      /* noop */
    });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { to: "/blog", onMouseEnter }, "Blog"),
      undefined
    );

    anchor.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })
    );

    expect(onMouseEnter).toHaveBeenCalled();
    cleanup();
  });

  test("mouse leave calls custom onMouseLeave", () => {
    const onMouseLeave = mock<(e: React.MouseEvent<HTMLAnchorElement>) => void>(() => {
      /* noop */
    });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { to: "/blog", onMouseLeave }, "Blog"),
      undefined
    );

    anchor.dispatchEvent(
      new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })
    );

    expect(onMouseLeave).toHaveBeenCalled();
    cleanup();
  });

  test("focus calls custom onFocus", () => {
    const onFocus = mock<(e: React.FocusEvent<HTMLAnchorElement>) => void>(() => {
      /* noop */
    });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { to: "/blog", onFocus }, "Blog"),
      undefined
    );

    anchor.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(onFocus).toHaveBeenCalled();
    cleanup();
  });

  // ── useRouter fallback (no provider) ─────────────────────────────────────────

  test("without RouterProvider, click falls back to window.location.href", () => {
    // Temporarily restore the real href setter so the fallback navigation works.
    if (originalHrefDescriptor) {
      Object.defineProperty(window.location, "href", originalHrefDescriptor);
    } else {
      // biome-ignore lint/performance/noDelete: removing an own property to restore prototype accessor behavior
      delete (window.location as unknown as Record<string, unknown>).href;
    }

    const originalHref = window.location.href;
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), undefined);

    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(window.location.href).toBe("http://localhost:3000/blog");
    cleanup();
    window.location.href = originalHref;
  });
});
