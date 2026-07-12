import { expect, test } from "bun:test";
import { act, createElement, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CompositeComponent, type CompositeComponentSource } from "../../../src/rsc/shared.tsx";
import { RSC_SOURCE, SLOT_MARKER } from "../../../src/rsc/symbols.ts";
import { installDom, resetDomState, uninstallDom, waitForDom } from "../../support/dom.ts";

test("CompositeComponent hydrates in the client graph without becoming an async client component", async () => {
  installDom();
  resetDomState();

  const errors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  let root: Root | undefined;
  try {
    const tree = Promise.resolve(
      createElement("section", null, createElement(SLOT_MARKER, { args: [], name: "children" }))
    ) as Promise<unknown> & { status: "fulfilled"; value: unknown };
    tree.status = "fulfilled";
    tree.value = await tree;
    const src: CompositeComponentSource<{ children?: unknown }> = {
      [RSC_SOURCE]: {
        bytes: new Uint8Array(),
        kind: "composite",
        tree,
      },
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        createElement(
          Suspense,
          { fallback: createElement("span", null, "loading") },
          createElement(
            CompositeComponent,
            { src },
            createElement("button", { type: "button" }, "Loaded")
          )
        )
      );
    });

    await waitForDom(() => container.textContent?.includes("Loaded") === true, {
      timeoutMs: 2000,
    });

    expect(container.innerHTML).toContain("<section>");
    expect(errors.join("\n")).not.toContain("async Client Component");
  } finally {
    console.error = originalConsoleError;
    act(() => {
      root?.unmount();
    });
    await uninstallDom();
  }
});
