import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { __resetCacheState } from "../../../packages/core/src/server/cache";

(globalThis as typeof globalThis & { __FURIN_SKIP_DOM_RESET?: boolean }).__FURIN_SKIP_DOM_RESET =
  true;

let deleteBoardResult = true;
let nextBoardId = "board-created";

mock.module("../src/api/modules/boards/service", () => ({
  createBoard: (name: string) => ({
    createdAt: "2026-05-01T00:00:00.000Z",
    id: nextBoardId,
    name,
  }),
  deleteBoard: () => deleteBoardResult,
  getBoardData: () => undefined,
  getBoardStats: () => undefined,
  getBoards: () => [],
}));

describe("boards API cache invalidation", () => {
  beforeEach(() => {
    __resetCacheState();
    deleteBoardResult = true;
    nextBoardId = "board-created";
  });

  afterEach(() => {
    __resetCacheState();
  });

  test("creating a board invalidates both the index page and board layout sidebars", async () => {
    const { boardPlugin } = await import("../src/api/modules/boards");

    const response = await boardPlugin.handle(
      new Request("http://furin/boards", {
        body: JSON.stringify({ name: "New board" }),
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "create-board-test",
        },
        method: "POST",
      })
    );

    expect(response.status).toBe(200);
    // The macro's afterHandle consumes the pending invalidations into the
    // response header — that is the contract observed by the SPA client.
    // Reading the header is the authoritative check; `consumePendingInvalidations`
    // is already drained by the macro at this point.
    expect(response.headers.get("x-furin-revalidate")).toBe("/,/rsc,/board:layout");
  });

  test("deleting a board invalidates both the index page and board layout sidebars", async () => {
    const { boardPlugin } = await import("../src/api/modules/boards");

    const response = await boardPlugin.handle(
      new Request("http://furin/boards/board-deleted", {
        headers: { "Idempotency-Key": "delete-board-test" },
        method: "DELETE",
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-furin-revalidate")).toBe("/,/rsc,/board:layout");
  });
});
