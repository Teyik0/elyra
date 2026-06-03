import { describe, expect, test } from "bun:test";
import { normalizeHref, toLogical } from "../../src/client/link.tsx";

const DOCS_ROUTE_RE = /^\/docs\/routing$/;
const ROOT_ROUTE_RE = /^\/$/;

describe("route matching with trailing slash", () => {
  test("toLogical preserves trailing slash from physical pathname", () => {
    // GitHub Pages may serve /furin/docs/routing/ with a trailing slash
    const logical = toLogical("/furin/docs/routing/", "/furin");
    expect(logical).toBe("/docs/routing/");
  });

  test("route regex does NOT match logical path with trailing slash", () => {
    const logical = toLogical("/furin/docs/routing/", "/furin");
    expect(DOCS_ROUTE_RE.test(logical)).toBe(false);
  });

  test("normalizeHref + toLogical enables route matching for trailing-slash URLs", () => {
    const logical = normalizeHref(toLogical("/furin/docs/routing/", "/furin"));
    expect(DOCS_ROUTE_RE.test(logical)).toBe(true);
  });

  test("root path with trailing slash normalizes to '/'", () => {
    const logical = normalizeHref(toLogical("/furin/", "/furin"));
    expect(logical).toBe("/");
  });

  test("root path regex matches normalized root", () => {
    const logical = normalizeHref(toLogical("/furin/", "/furin"));
    expect(ROOT_ROUTE_RE.test(logical)).toBe(true);
  });
});
