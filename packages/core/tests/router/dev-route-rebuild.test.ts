import { describe, expect, test } from "bun:test";
import type { RuntimePage, RuntimeRoute } from "../../src/client.ts";
import { type ResolvedRoute, rebuildDevRoute } from "../../src/router.ts";

function makeRuntimeRoute(overrides: Partial<RuntimeRoute>): RuntimeRoute {
  return { __type: "FURIN_ROUTE", ...overrides };
}

function makePage(routeOverrides: Partial<RuntimeRoute>, hasLoader: boolean): RuntimePage {
  const _route = makeRuntimeRoute(routeOverrides);
  const page: RuntimePage = {
    __type: "FURIN_PAGE",
    _route,
    component: () => null,
  };
  if (hasLoader) {
    page.loader = () => ({});
  }
  return page;
}

function makeBase(mode: "ssr" | "ssg" | "isr"): ResolvedRoute {
  return {
    pattern: "/foo",
    path: "/abs/pages/foo.tsx",
    mode,
    page: makePage({}, false),
    routeChain: [makeRuntimeRoute({})],
    segmentBoundaries: [],
  };
}

describe("rebuildDevRoute", () => {
  test("recomputes mode from the fresh page, not from base.mode", () => {
    const base = makeBase("ssr");
    const freshPage = makePage({ revalidate: 60 }, true);
    const freshChain: RuntimeRoute[] = [makeRuntimeRoute({})];

    const result = rebuildDevRoute(base, freshPage, freshChain);

    expect(result.mode).toBe("isr");
  });

  test("ISR → SSR: removing revalidate while keeping a loader downgrades the mode", () => {
    const base = makeBase("isr");
    const freshPage = makePage({}, true);
    const freshChain: RuntimeRoute[] = [makeRuntimeRoute({})];

    const result = rebuildDevRoute(base, freshPage, freshChain);

    expect(result.mode).toBe("ssr");
  });

  test("SSR → ISR: adding revalidate to a route with a loader upgrades the mode", () => {
    const base = makeBase("ssr");
    const freshPage = makePage({ revalidate: 30 }, true);
    const freshChain: RuntimeRoute[] = [makeRuntimeRoute({})];

    const result = rebuildDevRoute(base, freshPage, freshChain);

    expect(result.mode).toBe("isr");
  });

  test("SSR → SSG: removing the loader (page + chain) flips the mode to SSG", () => {
    const base = makeBase("ssr");
    const freshPage = makePage({}, false);
    const freshChain: RuntimeRoute[] = [makeRuntimeRoute({})];

    const result = rebuildDevRoute(base, freshPage, freshChain);

    expect(result.mode).toBe("ssg");
  });

  test("preserves structural fields and replaces page + routeChain with the args", () => {
    const baseSegmentBoundaries = [{ depth: 0, path: "/abs/pages" }];
    const baseError = () => null;
    const baseNotFound = () => null;
    const base: ResolvedRoute = {
      pattern: "/foo",
      path: "/abs/pages/foo.tsx",
      mode: "ssr",
      page: makePage({}, true),
      routeChain: [makeRuntimeRoute({}), makeRuntimeRoute({})],
      segmentBoundaries: baseSegmentBoundaries,
      error: baseError,
      notFound: baseNotFound,
    };
    const freshPage = makePage({ revalidate: 10 }, true);
    const freshChain: RuntimeRoute[] = [makeRuntimeRoute({})];

    const result = rebuildDevRoute(base, freshPage, freshChain);

    expect(result.pattern).toBe(base.pattern);
    expect(result.path).toBe(base.path);
    expect(result.segmentBoundaries).toBe(baseSegmentBoundaries);
    expect(result.error).toBe(baseError);
    expect(result.notFound).toBe(baseNotFound);
    expect(result.page).toBe(freshPage);
    expect(result.routeChain).toBe(freshChain);
    expect(result.mode).toBe("isr");
  });
});
