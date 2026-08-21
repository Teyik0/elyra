import { expect, mock, test } from "bun:test";
import {
  installDom,
  resetDomState,
  useDomTests as setupDomTests,
} from "../../../packages/core/tests/support/dom.ts";

installDom();
resetDomState();

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");

setupDomTests();

mock.module("../src/components/ui/kanban", () => ({
  Kanban: () => null,
}));

mock.module("../src/lib/api", () => ({
  apiClient: {
    api: {
      boards: () => ({
        stats: { get: () => Promise.resolve({ data: null, error: null }) },
      }),
    },
  },
}));

const { BoardPageContent } = await import("../src/components/board-page-content");

const initialStats = {
  byColumn: { backlog: 1, doing: 0, done: 0, todo: 0 },
  completionRate: 0,
  total: 1,
};

const refreshedStats = {
  byColumn: { backlog: 0, doing: 0, done: 1, todo: 0 },
  completionRate: 100,
  total: 1,
};

test("renders refreshed stats received from a remote loader refresh", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.appendChild(container);

  try {
    await act(() => {
      root.render(
        createElement(BoardPageContent, {
          boardId: "board-1",
          boardName: "Board",
          initialCards: [],
          initialStats: Promise.resolve(initialStats),
          renderedAt: "10:00:00",
        })
      );
    });
    expect(container.textContent).toContain("0% done");

    await act(() => {
      root.render(
        createElement(BoardPageContent, {
          boardId: "board-1",
          boardName: "Board",
          initialCards: [],
          initialStats: Promise.resolve(refreshedStats),
          renderedAt: "10:00:01",
        })
      );
    });

    expect(container.textContent).toContain("100% done");
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
