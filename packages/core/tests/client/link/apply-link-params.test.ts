import { describe, expect, test } from "bun:test";
import { applyLinkParams } from "../../../src/client/router/link-utils.ts";

describe("applyLinkParams", () => {
  test("substitutes :params into the pattern", () => {
    expect(applyLinkParams("/board/:boardId", { boardId: 42 })).toBe("/board/42");
    expect(applyLinkParams("/board/:boardId", { boardId: "42" })).toBe("/board/42");
  });

  test("substitutes multiple params", () => {
    expect(applyLinkParams("/board/:boardId/card/:cardId", { boardId: "1", cardId: "2" })).toBe(
      "/board/1/card/2"
    );
  });

  test('replaces the wildcard segment from params["*"]', () => {
    expect(applyLinkParams("/docs/*", { "*": "a/b/c" })).toBe("/docs/a/b/c");
  });

  test("leaves unknown segments untouched", () => {
    expect(applyLinkParams("/board/:boardId", {})).toBe("/board/:boardId");
    expect(applyLinkParams("/board/:boardId", null)).toBe("/board/:boardId");
    expect(applyLinkParams("/board/:boardId", undefined)).toBe("/board/:boardId");
  });

  test("plain paths pass through unchanged", () => {
    expect(applyLinkParams("/about", { anything: 1 })).toBe("/about");
    expect(applyLinkParams("/about", undefined)).toBe("/about");
  });
});
