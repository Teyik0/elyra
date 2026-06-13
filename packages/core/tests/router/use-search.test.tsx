import { describe, expect, mock, test } from "bun:test";
import { act, createElement, useEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { RouterContext, type RouterContextValue } from "../../src/client/link.tsx";
import { useSearch, useSetSearch } from "../../src/client/router/search/index.ts";

function makeRouterContext(overrides: Partial<RouterContextValue> | undefined): RouterContextValue {
  return {
    basePath: "",
    currentHref: "/",
    search: {},
    navigate: (_href, _opts) => Promise.resolve(),
    prefetch: (_href, _opts) => {
      /* noop */
    },
    invalidatePrefetch: (_path, _type) => {
      /* noop */
    },
    refresh: (_opts) => Promise.resolve(),
    isNavigating: false,
    defaultPreload: "intent",
    defaultPreloadDelay: 50,
    defaultPreloadStaleTime: 30_000,
    ...(overrides ?? {}),
  };
}

function renderWithRouter(
  element: React.ReactElement,
  ctx: RouterContextValue
): {
  cleanup: () => void;
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
    root.render(createElement(RouterContext.Provider, { value: ctx }, element));
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

describe("useSearch", () => {
  test("reads the current server-resolved search from router context", () => {
    function Page(): React.ReactElement {
      const search = useSearch("/products");
      return createElement("output", null, String(search.page));
    }

    const rendered = renderWithRouter(
      createElement(Page),
      makeRouterContext({ currentHref: "/products?page=2", search: { page: 2 } })
    );

    expect(rendered.container.textContent).toBe("2");
    rendered.cleanup();
  });

  test("returns an empty object for routes without search", () => {
    function Page(): React.ReactElement {
      const search = useSearch("/");
      return createElement("output", null, JSON.stringify(search));
    }

    const rendered = renderWithRouter(createElement(Page), makeRouterContext({ search: {} }));

    expect(rendered.container.textContent).toBe("{}");
    rendered.cleanup();
  });
});

describe("useSetSearch", () => {
  test("updates search by navigating from the current logical pathname", async () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());

    function Page(): React.ReactElement {
      const setSearch = useSetSearch("/products");
      useEffect(() => {
        setSearch({ page: 2 }, undefined);
      }, [setSearch]);
      return createElement("output");
    }

    const rendered = renderWithRouter(
      createElement(Page),
      makeRouterContext({
        currentHref: "/products?page=1",
        navigate,
        search: { page: 1 },
      })
    );

    try {
      await act(async () => {
        await Promise.resolve();
      });
      expect(navigate).toHaveBeenCalledWith("/products?page=2", { replace: false });
    } finally {
      rendered.cleanup();
    }
  });

  test("merges functional updates with the current search", async () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());

    function Page(): React.ReactElement {
      const setSearch = useSetSearch("/products");
      useEffect(() => {
        setSearch((prev) => ({ page: Number(prev.page) + 1 }), undefined);
      }, [setSearch]);
      return createElement("output");
    }

    const rendered = renderWithRouter(
      createElement(Page),
      makeRouterContext({
        currentHref: "/products?page=1&tag=react",
        navigate,
        search: { page: 1, tag: "react" },
      })
    );

    try {
      await act(async () => {
        await Promise.resolve();
      });
      expect(navigate).toHaveBeenCalledWith("/products?page=2&tag=react", { replace: false });
    } finally {
      rendered.cleanup();
    }
  });

  test("passes replace option to router navigation", async () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());

    function Page(): React.ReactElement {
      const setSearch = useSetSearch("/products");
      useEffect(() => {
        setSearch({ page: 2 }, { replace: true });
      }, [setSearch]);
      return createElement("output");
    }

    const rendered = renderWithRouter(
      createElement(Page),
      makeRouterContext({
        currentHref: "/products?page=1",
        navigate,
        search: { page: 1 },
      })
    );

    try {
      await act(async () => {
        await Promise.resolve();
      });
      expect(navigate).toHaveBeenCalledWith("/products?page=2", { replace: true });
    } finally {
      rendered.cleanup();
    }
  });
});
