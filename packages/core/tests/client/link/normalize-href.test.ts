import { describe, expect, test } from "bun:test";
import { normalizeHref } from "../../../src/client/link.tsx";

describe("normalizeHref", () => {
  test("strips trailing slash from a path", () => {
    expect(normalizeHref("/docs/routing/")).toBe("/docs/routing");
  });

  test("leaves root slash intact", () => {
    expect(normalizeHref("/")).toBe("/");
  });

  test("leaves path without trailing slash unchanged", () => {
    expect(normalizeHref("/docs/routing")).toBe("/docs/routing");
  });

  test("strips multiple trailing slashes", () => {
    expect(normalizeHref("/docs/routing///")).toBe("/docs/routing");
  });

  test("handles path with query string and trailing slash", () => {
    expect(normalizeHref("/docs/routing/?foo=bar")).toBe("/docs/routing?foo=bar");
  });

  test("preserves root slash with query string", () => {
    expect(normalizeHref("/?foo=bar")).toBe("/?foo=bar");
  });

  test("preserves hash fragment", () => {
    expect(normalizeHref("/docs/routing/#section")).toBe("/docs/routing#section");
  });
});
