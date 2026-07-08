/// <reference lib="dom" />

import { afterAll, describe, expect, test } from "bun:test";
import { shouldInterceptClick } from "../../src/client/link.tsx";

function makeAnchor(
  href: string,
  overrides: { target?: string; download?: boolean }
): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = href;
  if (overrides.target) {
    a.target = overrides.target;
  }
  if (overrides.download) {
    a.setAttribute("download", "");
  }
  return a;
}

function makeMouseEvent(overrides: {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): MouseEvent {
  return new MouseEvent("click", {
    altKey: overrides.altKey ?? false,
    ctrlKey: overrides.ctrlKey ?? false,
    metaKey: overrides.metaKey ?? false,
    shiftKey: overrides.shiftKey ?? false,
  });
}

const originalHref = window.location.href;

afterAll(() => {
  window.location.href = originalHref;
});

describe("shouldInterceptClick", () => {
  test("returns logical href for same-origin internal link", () => {
    const a = makeAnchor("http://localhost:3000/docs/routing", {});
    const event = makeMouseEvent({});
    expect(shouldInterceptClick(a, event, "", "http://localhost:3000", "/")).toBe("/docs/routing");
  });

  test("strips trailing slash from intercepted link", () => {
    const a = makeAnchor("http://localhost:3000/docs/routing/", {});
    const event = makeMouseEvent({});
    expect(shouldInterceptClick(a, event, "", "http://localhost:3000", "/")).toBe("/docs/routing");
  });

  test("handles basePath correctly", () => {
    const a = makeAnchor("http://localhost:3000/furin/docs/routing", {});
    const event = makeMouseEvent({});
    expect(shouldInterceptClick(a, event, "/furin", "http://localhost:3000", "/")).toBe(
      "/docs/routing"
    );
  });

  test("returns null for external link", () => {
    const a = makeAnchor("https://example.com", {});
    const event = makeMouseEvent({});
    expect(shouldInterceptClick(a, event, "", "http://localhost:3000", "/")).toBeNull();
  });

  test("returns null when ctrl key is pressed", () => {
    const a = makeAnchor("http://localhost:3000/docs", {});
    const event = makeMouseEvent({ ctrlKey: true });
    expect(shouldInterceptClick(a, event, "", "http://localhost:3000", "/")).toBeNull();
  });

  test("returns null when target is _blank", () => {
    const a = makeAnchor("http://localhost:3000/docs", { target: "_blank" });
    const event = makeMouseEvent({});
    expect(shouldInterceptClick(a, event, "", "http://localhost:3000", "/")).toBeNull();
  });

  test("returns null for download links", () => {
    const a = makeAnchor("http://localhost:3000/file.pdf", { download: true });
    const event = makeMouseEvent({});
    expect(shouldInterceptClick(a, event, "", "http://localhost:3000", "/")).toBeNull();
  });

  test("returns null for hash-only navigation on same page", () => {
    window.location.href = "http://localhost:3000/docs";
    const a = makeAnchor("http://localhost:3000/docs#section", {});
    const event = makeMouseEvent({});
    expect(shouldInterceptClick(a, event, "", "http://localhost:3000", "/docs")).toBeNull();
  });

  test("returns null for hash-only navigation when trailing slash differs", () => {
    try {
      window.location.href = "http://localhost:3000/docs/";
      const a1 = makeAnchor("http://localhost:3000/docs#section", {});
      expect(
        shouldInterceptClick(a1, makeMouseEvent({}), "", "http://localhost:3000", "/docs/")
      ).toBeNull();

      window.location.href = "http://localhost:3000/docs";
      const a2 = makeAnchor("http://localhost:3000/docs/#section", {});
      expect(
        shouldInterceptClick(a2, makeMouseEvent({}), "", "http://localhost:3000", "/docs")
      ).toBeNull();
    } finally {
      window.location.href = originalHref;
    }
  });

  test("preserves query string in intercepted href", () => {
    const a = makeAnchor("http://localhost:3000/docs?page=2", {});
    const event = makeMouseEvent({});
    expect(shouldInterceptClick(a, event, "", "http://localhost:3000", "/")).toBe("/docs?page=2");
  });

  test("preserves hash in intercepted href", () => {
    const a = makeAnchor("http://localhost:3000/docs#section", {});
    const event = makeMouseEvent({});
    expect(shouldInterceptClick(a, event, "", "http://localhost:3000", "/")).toBe("/docs#section");
  });
});
