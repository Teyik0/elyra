import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { type SyncMutationOptions, type UseSyncOptions, useSync } from "../src/client.ts";

interface CardPatch {
  title: string;
}

interface MutationResult {
  data: { ok: true } | null;
  error: { message: string } | null;
}

function renderHook<TInput, TResult>(
  mutation: (input: TInput, options: SyncMutationOptions) => Promise<TResult>,
  options: UseSyncOptions<TInput, TResult> | undefined
): { cleanup: () => void; run: (input: TInput) => Promise<TResult> } {
  let run: ((input: TInput) => Promise<TResult>) | undefined;
  const container = document.createElement("div");
  const root = createRoot(container);

  function TestComponent() {
    run = useSync(mutation, options);
    return null;
  }

  document.body.appendChild(container);
  flushSync(() => {
    root.render(createElement(TestComponent));
  });

  if (!run) {
    throw new Error("Expected useSync callback to be registered");
  }

  return {
    run,
    cleanup: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

function renderVoidHook<TResult>(
  mutation: (input: undefined, options: SyncMutationOptions) => Promise<TResult>,
  options: UseSyncOptions<undefined, TResult> | undefined
): { cleanup: () => void; run: () => Promise<TResult> } {
  let run: (() => Promise<TResult>) | undefined;
  const container = document.createElement("div");
  const root = createRoot(container);

  function TestComponent() {
    run = useSync(mutation, options);
    return null;
  }

  document.body.appendChild(container);
  flushSync(() => {
    root.render(createElement(TestComponent));
  });

  if (!run) {
    throw new Error("Expected useSync callback to be registered");
  }

  return {
    run,
    cleanup: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

describe("useSync", () => {
  test("calls a mutation without input without requiring a placeholder argument", async () => {
    const calls: Array<{ input: undefined; key: string }> = [];
    const mutation = (input: undefined, options: SyncMutationOptions): Promise<MutationResult> => {
      calls.push({ input, key: options.headers["Idempotency-Key"] });
      return Promise.resolve({ data: { ok: true }, error: null });
    };
    const { cleanup, run } = renderVoidHook(mutation, undefined);

    try {
      const result = await run();

      expect(result).toEqual({ data: { ok: true }, error: null });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toBeUndefined();
      expect(calls[0]?.key.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  test("calls the mutation with the input and a generated Idempotency-Key", async () => {
    const calls: Array<{ input: CardPatch; key: string }> = [];
    const optimisticInputs: CardPatch[] = [];
    const successResults: MutationResult[] = [];
    const mutation = (input: CardPatch, options: SyncMutationOptions): Promise<MutationResult> => {
      calls.push({ input, key: options.headers["Idempotency-Key"] });
      return Promise.resolve({ data: { ok: true }, error: null });
    };

    const { cleanup, run } = renderHook(mutation, {
      optimistic: ({ input }) => {
        optimisticInputs.push(input);
      },
      onSuccess: ({ result }) => {
        successResults.push(result);
      },
    });

    try {
      const result = await run({ title: "Renamed" });

      expect(result).toEqual({ data: { ok: true }, error: null });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toEqual({ title: "Renamed" });
      expect(calls[0]?.key.length).toBeGreaterThan(0);
      expect(optimisticInputs).toEqual([{ title: "Renamed" }]);
      expect(successResults).toEqual([{ data: { ok: true }, error: null }]);
    } finally {
      cleanup();
    }
  });

  test("rolls back optimistic updates when an Eden-style response resolves with error", async () => {
    const events: string[] = [];
    const mutation = async (): Promise<MutationResult> => ({
      data: null,
      error: { message: "failed" },
    });

    const { cleanup, run } = renderHook<CardPatch, MutationResult>(mutation, {
      optimistic: () => {
        events.push("optimistic");
        return () => events.push("rollback");
      },
      onError: ({ error }) => {
        events.push((error as { message: string }).message);
      },
    });

    try {
      const result = await run({ title: "Renamed" });

      expect(result).toEqual({ data: null, error: { message: "failed" } });
      expect(events).toEqual(["optimistic", "rollback", "failed"]);
    } finally {
      cleanup();
    }
  });
});
