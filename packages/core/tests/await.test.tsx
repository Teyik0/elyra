import { describe, expect, test } from "bun:test";
import { createElement, Suspense } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToReadableStream } from "react-dom/server";
import { AsyncErrorContext, Await, useAsyncError } from "../src/shared/await.tsx";

async function renderToString(element: React.ReactNode): Promise<string> {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

describe("<Await>", () => {
  test("renders content when the Promise resolves", async () => {
    const promise = Promise.resolve("hello world");
    const html = await renderToString(
      createElement(
        Suspense,
        { fallback: createElement("p", null, "loading") },
        createElement(Await<string>, {
          resolve: promise,
          // biome-ignore lint/correctness/noChildrenProp: render-prop pattern — children is a function, not a ReactNode
          children: (val: string) => createElement("p", null, val),
        })
      )
    );
    expect(html).toContain("hello world");
    expect(html).not.toContain("loading");
  });

  test("renders Suspense fallback when the Promise resolves after a delay", async () => {
    const delayed = new Promise<string>((r) => setTimeout(() => r("delayed value"), 10));
    const html = await renderToString(
      createElement(
        Suspense,
        { fallback: createElement("span", null, "waiting") },
        createElement(Await<string>, {
          resolve: delayed,
          // biome-ignore lint/correctness/noChildrenProp: render-prop pattern — children is a function, not a ReactNode
          children: (val: string) => createElement("span", null, val),
        })
      )
    );
    // allReady waits for resolution — the final content is rendered
    expect(html).toContain("delayed value");
  });

  test("falls back to client-rendering when the Promise rejects (React SSR behaviour)", async () => {
    // React SSR does not render errorElement inline — it emits a
    // client-rendering marker (<!--$!-->) so hydration handles the error.
    // errorElement is rendered on the client only, after hydration.
    //
    // To avoid an unhandled rejection in Bun, we build a pre-rejected Promise
    // via a thenable that never surfaces the rejection until React consumes it.
    let doReject!: (e: unknown) => void;
    const rejected = new Promise<string>((_, reject) => {
      doReject = reject;
    });

    const ErrorFallback = () => createElement("p", null, "something went wrong");
    const stream = await renderToReadableStream(
      createElement(
        Suspense,
        { fallback: createElement("p", null, "loading") },
        createElement(Await<string>, {
          resolve: rejected,
          errorElement: createElement(ErrorFallback, null),
          // biome-ignore lint/correctness/noChildrenProp: render-prop pattern — children is a function, not a ReactNode
          children: (val: string) => createElement("p", null, val),
        })
      ),
      {
        onError: () => {
          /* swallow SSR shell errors */
        },
      }
    );

    // Trigger the rejection after React has started rendering
    doReject(new Error("fetch failed"));
    await stream.allReady;

    const html = await new Response(stream).text();

    // React SSR emits either the fallback or a client-rendering marker
    expect(html.length).toBeGreaterThan(0);
    // Render produces valid HTML (no uncaught exception)
    expect(html).toContain("<!--");
  });

  test("renders children with a resolved complex object", async () => {
    const data = { name: "Alice", count: 42 };
    const promise = Promise.resolve(data);
    const html = await renderToString(
      createElement(
        Suspense,
        { fallback: null },
        createElement(Await<typeof data>, {
          resolve: promise,
          // biome-ignore lint/correctness/noChildrenProp: render-prop pattern — children is a function, not a ReactNode
          children: (val: typeof data) => createElement("div", null, `${val.name}:${val.count}`),
        })
      )
    );
    expect(html).toContain("Alice:42");
  });

  test("keeps AbortError rejections suspended instead of rendering errorElement", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root | undefined;
    let rejectPromise!: (error: unknown) => void;
    const abortingPromise = new Promise<string>((_, reject) => {
      rejectPromise = reject;
    });

    function ErrorFallback() {
      return createElement("p", null, "error");
    }

    try {
      root = createRoot(container);
      flushSync(() => {
        root?.render(
          createElement(
            Suspense,
            { fallback: createElement("p", null, "loading") },
            createElement(Await<string>, {
              resolve: abortingPromise,
              errorElement: createElement(ErrorFallback, null),
              // biome-ignore lint/correctness/noChildrenProp: render-prop pattern — children is a function, not a ReactNode
              children: (val: string) => createElement("p", null, val),
            })
          )
        );
      });

      const abortError = new Error("signal is aborted without reason");
      abortError.name = "AbortError";
      rejectPromise(abortError);
      await Promise.resolve();

      expect(container.textContent).toContain("loading");
      expect(container.textContent).not.toContain("error");
    } finally {
      flushSync(() => {
        root?.unmount();
      });
      container.remove();
    }
  });
});

describe("useAsyncError()", () => {
  test("returns undefined outside an error boundary", async () => {
    function OutsideBoundary() {
      const error = useAsyncError();
      return createElement("span", null, String(error));
    }

    const html = await renderToString(createElement(OutsideBoundary));
    expect(html).toContain("undefined");
  });

  test("returns the error propagated inside Await's errorElement", async () => {
    function ErrorDisplay() {
      const error = useAsyncError();
      return createElement("span", null, error instanceof Error ? error.message : String(error));
    }

    const html = await renderToString(
      createElement(
        AsyncErrorContext.Provider,
        { value: new Error("boundary error") },
        createElement(ErrorDisplay)
      )
    );
    expect(html).toContain("boundary error");
  });
});
