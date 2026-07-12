import { describe, expect, mock, test } from "bun:test";
import { act, createElement, memo, useEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { RouterContext, type RouterContextValue } from "../../../src/client/link.tsx";
import { useNavigate } from "../../../src/client/router/navigation.ts";
import { useSearch } from "../../../src/client/router/search/index.ts";
import {
  createSearchStore,
  type SearchStore,
  SearchStoreContext,
  searchSnapshotFromRouterContext,
} from "../../../src/client/router/search-store.ts";
import { useDomTests } from "../../support/dom.ts";

const PRODUCTS_RE = /^\/products$/;

function makeRouterContext(overrides: Partial<RouterContextValue> | undefined): RouterContextValue {
  return {
    basePath: "",
    currentHref: "/",
    defaultPreload: "intent",
    defaultPreloadDelay: 50,
    defaultPreloadStaleTime: 30_000,
    invalidatePrefetch: (_path, _type) => {
      /* noop */
    },
    isNavigating: false,
    navigate: (_href, _opts) => Promise.resolve(),
    prefetch: (_href, _opts) => {
      /* noop */
    },
    refresh: (_opts) => Promise.resolve(),
    search: {},
    searchRoutes: [],
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
  searchStore: SearchStore;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const searchStore = createSearchStore(searchSnapshotFromRouterContext(ctx));

  flushSync(() => {
    root.render(
      createElement(
        SearchStoreContext.Provider,
        { value: searchStore },
        createElement(RouterContext.Provider, { value: ctx }, element)
      )
    );
  });

  return {
    cleanup: () => {
      flushSync(() => {
        root.unmount();
      });
      container.remove();
    },
    container,
    root,
    searchStore,
  };
}

describe("useSearch", () => {
  useDomTests();

  test("reads the current server-resolved search from router context", () => {
    function Page(): React.ReactElement {
      const [search] = useSearch("/products");
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
      const [search] = useSearch("/");
      return createElement("output", null, JSON.stringify(search));
    }

    const rendered = renderWithRouter(createElement(Page), makeRouterContext({ search: {} }));

    expect(rendered.container.textContent).toBe("{}");
    rendered.cleanup();
  });

  test("selector subscribers do not rerender when the selected value is unchanged", () => {
    let renders = 0;

    const PageSelector = memo(function PageSelectorComponent(): React.ReactElement {
      renders += 1;
      const [page] = useSearch("/products", (search) => search.page);
      return createElement("output", null, String(page));
    });

    const rendered = renderWithRouter(
      createElement(PageSelector),
      makeRouterContext({
        currentHref: "/products?page=1&q=react",
        search: { page: 1, q: "react" },
      })
    );

    expect(rendered.container.textContent).toBe("1");
    expect(renders).toBe(1);

    flushSync(() => {
      rendered.searchStore.setSnapshot({
        currentHref: "/products?page=1&q=bun",
        navigate: () => Promise.resolve(),
        search: { page: 1, q: "bun" },
        searchRoutes: [],
      });
      rendered.searchStore.flush();
    });

    expect(rendered.container.textContent).toBe("1");
    expect(renders).toBe(1);

    flushSync(() => {
      rendered.searchStore.setSnapshot({
        currentHref: "/products?page=2&q=bun",
        navigate: () => Promise.resolve(),
        search: { page: 2, q: "bun" },
        searchRoutes: [],
      });
      rendered.searchStore.flush();
    });

    expect(rendered.container.textContent).toBe("2");
    expect(renders).toBe(2);
    rendered.cleanup();
  });
});

describe("useNavigate", () => {
  useDomTests();

  test("navigates with typed search and omits default-equivalent values", async () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());

    function Page(): React.ReactElement {
      const go = useNavigate();
      useEffect(() => {
        go({ search: { page: 1 }, to: "/products" });
      }, [go]);
      return createElement("output");
    }

    const rendered = renderWithRouter(
      createElement(Page),
      makeRouterContext({
        navigate,
        searchRoutes: [
          {
            pattern: "/products",
            regex: PRODUCTS_RE,
            searchDefaults: { page: 1 },
          },
        ],
      })
    );

    try {
      await act(async () => {
        await Promise.resolve();
      });
      expect(navigate).toHaveBeenCalledWith("/products", undefined);
    } finally {
      rendered.cleanup();
    }
  });

  test("passes replace and resetScroll options to router navigation", async () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());

    function Page(): React.ReactElement {
      const go = useNavigate();
      useEffect(() => {
        go({ replace: true, resetScroll: false, to: "/products" });
      }, [go]);
      return createElement("output");
    }

    const rendered = renderWithRouter(createElement(Page), makeRouterContext({ navigate }));

    try {
      await act(async () => {
        await Promise.resolve();
      });
      expect(navigate).toHaveBeenCalledWith("/products", {
        replace: true,
        resetScroll: false,
      });
    } finally {
      rendered.cleanup();
    }
  });
});

describe("useSearch setter", () => {
  useDomTests();

  test("updates search by navigating from the current logical pathname", async () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());

    function Page(): React.ReactElement {
      const [, setSearch] = useSearch("/products");
      useEffect(() => {
        setSearch({ page: 2 });
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
      expect(navigate).toHaveBeenCalledWith("/products?page=2", undefined);
    } finally {
      rendered.cleanup();
    }
  });

  test("can replace the current history entry", async () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());

    function Page(): React.ReactElement {
      const [, setSearch] = useSearch("/products");
      useEffect(() => {
        setSearch({ page: 2 }, { replace: true, resetScroll: false });
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
      expect(navigate).toHaveBeenCalledWith("/products?page=2", {
        replace: true,
        resetScroll: false,
      });
    } finally {
      rendered.cleanup();
    }
  });

  test("merges functional updates with the current search", async () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());

    function Page(): React.ReactElement {
      const [, setSearch] = useSearch("/products");
      useEffect(() => {
        setSearch((prev) => ({ page: Number(prev.page) + 1 }));
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
      expect(navigate).toHaveBeenCalledWith("/products?page=2&tag=react", undefined);
    } finally {
      rendered.cleanup();
    }
  });

  test("omits default-equivalent values from the navigated URL", async () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());

    function Page(): React.ReactElement {
      const [, setSearch] = useSearch("/products");
      useEffect(() => {
        setSearch({ page: 1 });
      }, [setSearch]);
      return createElement("output");
    }

    const rendered = renderWithRouter(
      createElement(Page),
      makeRouterContext({
        currentHref: "/products?page=2",
        navigate,
        search: { page: 2 },
        searchRoutes: [
          {
            pattern: "/products",
            regex: PRODUCTS_RE,
            searchDefaults: { page: 1 },
          },
        ],
      } as Partial<RouterContextValue>)
    );

    try {
      await act(async () => {
        await Promise.resolve();
      });
      expect(navigate).toHaveBeenCalledWith("/products", undefined);
    } finally {
      rendered.cleanup();
    }
  });
});
