import { describe, expect, test } from "bun:test";
import {
  assertNoPrefixSlugCollisions,
  clientDirNameForPrefix,
  prefixSlug,
} from "../src/shared/prefix";

describe("clientDirNameForPrefix / prefixSlug", () => {
  test("root prefix keeps the historical client/ dir", () => {
    expect(clientDirNameForPrefix("")).toBe("client");
  });

  test("prefixed apps get client-<slug>/ with slashes flattened to dashes", () => {
    expect(prefixSlug("/admin")).toBe("admin");
    expect(prefixSlug("/admin/v2")).toBe("admin-v2");
    expect(clientDirNameForPrefix("/admin/v2")).toBe("client-admin-v2");
  });
});

describe("assertNoPrefixSlugCollisions", () => {
  test("accepts distinct prefixes with distinct slugs", () => {
    expect(() => assertNoPrefixSlugCollisions(["", "/admin", "/shop/v2"])).not.toThrow();
  });

  test("accepts repeated occurrences of the same prefix", () => {
    // Exact duplicates are the duplicate-prefix check's job, not a slug collision.
    expect(() => assertNoPrefixSlugCollisions(["/admin", "/admin"])).not.toThrow();
  });

  test("rejects distinct prefixes whose slugs collide (/a-b vs /a/b)", () => {
    expect(() => assertNoPrefixSlugCollisions(["/a-b", "/a/b"])).toThrow(
      '"/a-b" and "/a/b" both map to the client directory "client-a-b"'
    );
  });
});
