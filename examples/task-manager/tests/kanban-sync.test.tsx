import { expect, mock, test } from "bun:test";

if (typeof document === "undefined") {
  await import("../../../tests/setup");
}

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

interface MutationResult {
  data: { column: "backlog"; id: string; title: string } | null;
  error: { message: string } | null;
}

let resolveCreate: ((result: MutationResult) => void) | undefined;
let createCalls = 0;
let resolveDelete:
  | ((result: { data: { ok: true } | null; error: { message: string } | null }) => void)
  | undefined;
let resolveMove:
  | ((result: { data: object | null; error: { message: string } | null }) => void)
  | undefined;

mock.module("../src/lib/api", () => ({
  apiClient: {
    api: {
      boards: () => ({
        cards: {
          post: () =>
            new Promise<MutationResult>((resolve) => {
              createCalls += 1;
              resolveCreate = resolve;
            }),
        },
        stats: { get: () => Promise.resolve({ data: null, error: null }) },
      }),
      cards: () => ({
        delete: () =>
          new Promise((resolve) => {
            resolveDelete = resolve;
          }),
        patch: () =>
          new Promise((resolve) => {
            resolveMove = resolve;
          }),
      }),
    },
  },
}));

const { Kanban } = await import("../src/components/ui/kanban");

interface TestDataTransfer {
  getData: (type: string) => string;
  setData: (type: string, value: string) => void;
}

function createDataTransfer(): TestDataTransfer {
  const values = new Map<string, string>();
  return {
    getData: (type) => values.get(type) ?? "",
    setData: (type, value) => values.set(type, value),
  };
}

function dispatchDrag(element: Element, type: string, dataTransfer: TestDataTransfer): void {
  const EventConstructor = document.defaultView?.Event ?? Event;
  const event = new EventConstructor(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  element.dispatchEvent(event);
}

function setTextareaValue(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
  setter?.call(element, value);
  const EventConstructor = document.defaultView?.Event ?? Event;
  const InputEventConstructor = document.defaultView?.InputEvent;
  element.dispatchEvent(
    InputEventConstructor
      ? new InputEventConstructor("input", { bubbles: true, inputType: "insertText", data: value })
      : new EventConstructor("input", { bubbles: true })
  );
  element.dispatchEvent(new EventConstructor("change", { bubbles: true }));
}

test("shows a created card optimistically before the server responds", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.appendChild(container);

  await act(() => {
    root.render(createElement(Kanban, { boardId: "board-1", initialCards: [] }));
  });

  try {
    const addButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Add card"
    );
    await act(() => addButton?.click());

    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="New task content"]'
    );
    const form = textarea?.closest("form");
    expect(textarea).not.toBeNull();
    expect(form).not.toBeNull();

    await act(() => {
      if (textarea) {
        setTextareaValue(textarea, "Optimistic task");
      }
    });
    await act(() => form?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());

    expect(container.textContent).toContain("Optimistic task");
    expect(createCalls).toBe(1);
    expect(container.querySelectorAll('[draggable="true"]')).toHaveLength(1);

    await act(async () => {
      resolveCreate?.({
        data: { column: "backlog", id: "card-created", title: "Optimistic task" },
        error: null,
      });
      await Promise.resolve();
    });
    expect(container.querySelectorAll('[draggable="true"]')).toHaveLength(1);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

test("applies remote create, move, and delete loader refreshes", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.appendChild(container);

  try {
    await act(() => {
      root.render(
        createElement(Kanban, {
          boardId: "board-1",
          initialCards: [{ column: "backlog", id: "card-1", title: "First task" }],
        })
      );
    });
    expect(container.textContent).toContain("First task");

    await act(() => {
      root.render(
        createElement(Kanban, {
          boardId: "board-1",
          initialCards: [
            { column: "backlog", id: "card-1", title: "First task" },
            { column: "todo", id: "card-2", title: "Remote task" },
          ],
        })
      );
    });
    expect(container.querySelectorAll("ul").item(1).textContent).toContain("Remote task");

    await act(() => {
      root.render(
        createElement(Kanban, {
          boardId: "board-1",
          initialCards: [
            { column: "done", id: "card-1", title: "First task" },
            { column: "todo", id: "card-2", title: "Remote task" },
          ],
        })
      );
    });
    expect(container.querySelectorAll("ul").item(3).textContent).toContain("First task");

    await act(() => {
      root.render(
        createElement(Kanban, {
          boardId: "board-1",
          initialCards: [{ column: "done", id: "card-1", title: "First task" }],
        })
      );
    });
    expect(container.textContent).not.toContain("Remote task");
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

test("removes an optimistic created card when creation fails", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.appendChild(container);

  try {
    await act(() => {
      root.render(createElement(Kanban, { boardId: "board-1", initialCards: [] }));
    });
    const addButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Add card"
    );
    await act(() => addButton?.click());
    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="New task content"]'
    );
    const form = textarea?.closest("form");
    await act(() => {
      if (textarea) {
        setTextareaValue(textarea, "Rejected task");
      }
    });
    await act(() => form?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
    expect(container.querySelector('[draggable="true"]')?.textContent).toContain("Rejected task");

    await act(async () => {
      resolveCreate?.({ data: null, error: { message: "failed" } });
      await Promise.resolve();
    });

    expect(container.querySelector('[draggable="true"]')).toBeNull();
    expect(container.textContent).toContain("failed");
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

test("removes a card optimistically and restores it when deletion fails", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.appendChild(container);

  try {
    await act(() => {
      root.render(
        createElement(Kanban, {
          boardId: "board-1",
          initialCards: [{ column: "backlog", id: "card-1", title: "Delete me" }],
        })
      );
    });
    const card = container.querySelector('[draggable="true"]');
    const barrel = container.querySelector('button[aria-label^="Delete card"]');
    expect(card).not.toBeNull();
    expect(barrel).not.toBeNull();

    const dataTransfer = createDataTransfer();
    await act(() => {
      if (card && barrel) {
        dispatchDrag(card, "dragstart", dataTransfer);
        dispatchDrag(barrel, "drop", dataTransfer);
      }
    });
    expect(container.textContent).not.toContain("Delete me");

    await act(async () => {
      resolveDelete?.({ data: null, error: { message: "failed" } });
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Delete me");
    expect(container.textContent).toContain("Could not delete the card");
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

test("moves a card optimistically and restores it when the move fails", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.appendChild(container);

  try {
    await act(() => {
      root.render(
        createElement(Kanban, {
          boardId: "board-1",
          initialCards: [{ column: "backlog", id: "card-1", title: "Move me" }],
        })
      );
    });
    const card = container.querySelector('[draggable="true"]');
    const columns = container.querySelectorAll("ul");
    const todoColumn = columns.item(1);
    const dataTransfer = createDataTransfer();

    await act(() => {
      if (card) {
        dispatchDrag(card, "dragstart", dataTransfer);
        dispatchDrag(todoColumn, "drop", dataTransfer);
      }
    });
    expect(todoColumn.textContent).toContain("Move me");

    await act(async () => {
      resolveMove?.({ data: null, error: { message: "failed" } });
      await Promise.resolve();
    });

    expect(columns.item(0).textContent).toContain("Move me");
    expect(todoColumn.textContent).not.toContain("Move me");
    expect(container.textContent).toContain("Could not move the card");
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
