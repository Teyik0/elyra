import { describe, expect, test } from "bun:test";
import {
  decodeHashFragment,
  isSameOriginFetchResult,
  navigationHrefPolicy,
} from "../../../src/client/router/link-utils.ts";

describe("navigationHrefPolicy", () => {
  test("blocks executable schemes and control characters", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "/safe\njavascript:alert(1)",
    ]) {
      expect(navigationHrefPolicy(href, "https://furin.test")).toBe("blocked");
    }
  });

  test("keeps internal URLs and explicit external HTTP URLs", () => {
    expect(navigationHrefPolicy("/docs?q=1#api", "https://furin.test")).toBe("internal");
    expect(navigationHrefPolicy("https://furin.test/docs", "https://furin.test")).toBe("internal");
    expect(navigationHrefPolicy("https://example.com/docs", "https://furin.test")).toBe("external");
  });
});

test("malformed hash escapes do not throw", () => {
  expect(decodeHashFragment("section%ZZ")).toBe("section%ZZ");
  expect(decodeHashFragment("section%20one")).toBe("section one");
});

test("revalidation fetch policy requires same-origin request and response URLs", () => {
  expect(
    isSameOriginFetchResult("/api/cards", "https://furin.test/api/cards", "https://furin.test")
  ).toBe(true);
  expect(
    isSameOriginFetchResult(
      "https://third-party.test/api",
      "https://furin.test/api",
      "https://furin.test"
    )
  ).toBe(false);
  expect(
    isSameOriginFetchResult("/api/cards", "https://third-party.test/api", "https://furin.test")
  ).toBe(false);
});
