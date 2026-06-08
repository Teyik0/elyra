import { describe, expect, test } from "bun:test";
import { compareRouteSpecificity, filePathToPattern } from "../../src/server/router/index.ts";

describe("filePathToPattern", () => {
  test("converts index route to root", () => {
    expect(filePathToPattern("index.tsx")).toBe("/");
  });

  test("converts simple route", () => {
    expect(filePathToPattern("about.tsx")).toBe("/about");
  });

  test("converts nested route", () => {
    expect(filePathToPattern("blog/index.tsx")).toBe("/blog");
  });

  test("converts nested route with filename", () => {
    expect(filePathToPattern("blog/post.tsx")).toBe("/blog/post");
  });

  test("converts dynamic route [slug]", () => {
    expect(filePathToPattern("blog/[slug].tsx")).toBe("/blog/:slug");
  });

  test("converts dynamic route at root level", () => {
    expect(filePathToPattern("[id].tsx")).toBe("/:id");
  });

  test("converts catch-all route [...path]", () => {
    expect(filePathToPattern("docs/[...path].tsx")).toBe("/docs/*");
  });

  test("converts catch-all route at root level", () => {
    expect(filePathToPattern("[...catch].tsx")).toBe("/*");
  });

  test("handles deeply nested route", () => {
    expect(filePathToPattern("a/b/c/index.tsx")).toBe("/a/b/c");
  });

  test("handles mixed segments", () => {
    expect(filePathToPattern("blog/[category]/[slug].tsx")).toBe("/blog/:category/:slug");
  });

  test("handles nested dynamic routes", () => {
    expect(filePathToPattern("users/[userId]/posts/[postId].tsx")).toBe(
      "/users/:userId/posts/:postId"
    );
  });

  test("handles index in nested folder", () => {
    expect(filePathToPattern("dashboard/settings/index.tsx")).toBe("/dashboard/settings");
  });

  test("handles multiple static segments", () => {
    expect(filePathToPattern("api/v1/users.tsx")).toBe("/api/v1/users");
  });

  test("handles dynamic and static mix", () => {
    expect(filePathToPattern("api/users/[id]/settings.tsx")).toBe("/api/users/:id/settings");
  });
});

describe("compareRouteSpecificity", () => {
  const moreSpecific = (a: string, b: string) => compareRouteSpecificity(a, b) > 0;

  test("literal segment outranks :param at the same position", () => {
    expect(moreSpecific("/users/new", "/users/:id")).toBe(true);
    expect(compareRouteSpecificity("/users/:id", "/users/new")).toBeLessThan(0);
  });

  test(":param outranks wildcard at the same position", () => {
    expect(moreSpecific("/docs/:section", "/docs/*")).toBe(true);
  });

  test("literal outranks wildcard at the same position", () => {
    expect(moreSpecific("/docs/api", "/docs/*")).toBe(true);
  });

  test("breaks the summed-weight tie by leftmost differing segment", () => {
    // Both summed to 8 under the old scoring (literal 3 + literal/param mix).
    // The literal `new` at position 1 wins over the `:id` param.
    expect(moreSpecific("/blog/new/:section", "/blog/:id/edit")).toBe(true);
  });

  test("is sign-consistent when arguments are swapped", () => {
    expect(compareRouteSpecificity("/blog/new/:section", "/blog/:id/edit")).toBeGreaterThan(0);
    expect(compareRouteSpecificity("/blog/:id/edit", "/blog/new/:section")).toBeLessThan(0);
  });

  test("more explicit segments outrank a shorter wildcard tail", () => {
    expect(moreSpecific("/docs/api/v1", "/docs/*")).toBe(true);
  });

  test("returns 0 for identical patterns", () => {
    expect(compareRouteSpecificity("/blog/:id", "/blog/:id")).toBe(0);
  });
});
