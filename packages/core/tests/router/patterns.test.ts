import { describe, expect, test } from "bun:test";
import { filePathToPattern } from "../../src/router";

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
