import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { buildRouterTree, type RouterContextValue } from "../src/link";

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

function ThrowOnRender(): React.ReactElement {
  throw new Error("boom");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildRouterTree — error boundary fallback navigation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalHref: string;
  let locationSpy: { set: ReturnType<typeof mock> };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    originalHref = window.location.href;
    locationSpy = { set: mock() };
    Object.defineProperty(window, "location", {
      configurable: true,
      get: () => ({ href: originalHref, origin: "http://localhost:3000" }),
      set: locationSpy.set as unknown as (v: string) => void,
    });
  });

  afterEach(async () => {
    await act(() => {
      root.unmount();
    });
    container.remove();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { href: originalHref },
    });
  });

  test("Link in default 500 fallback navigates via SPA (not full reload)", async () => {
    const navigateSpy = mock(() => Promise.resolve());
    const ctx = makeRouterContext({
      navigate: navigateSpy as unknown as RouterContextValue["navigate"],
    });

    const tree = buildRouterTree(ctx, createElement(ThrowOnRender), {});

    await act(() => {
      root.render(tree);
    });

    // The error boundary should have caught the throw and rendered DefaultErrorScreen
    const anchor = container.querySelector('a[href="/"]') as HTMLAnchorElement | null;
    expect(anchor).not.toBeNull();
    if (!anchor) {
      throw new Error("Anchor not found");
    }
    expect(anchor.textContent).toContain("Go Home");

    // Simulate a plain left-click (no modifiers)
    const clickEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
    });
    anchor.dispatchEvent(clickEvent);

    // The Link should have used router.navigate() (SPA) instead of window.location.href (full reload)
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(navigateSpy).toHaveBeenCalledWith("/", { replace: undefined, resetScroll: true });
    expect(locationSpy.set).not.toHaveBeenCalled();
  });
});
