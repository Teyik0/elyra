import { expect, test } from "bun:test";
import {
  pendingISRRevalidations,
  waitForPendingISRRevalidations,
} from "../../../src/server/cache/isr.ts";
import {
  __clearInstanceRegistry,
  createInstance,
  registerInstance,
  withInstance,
} from "../../../src/server/instance.ts";

test("waiting for ISR revalidation includes every mounted app", async () => {
  const first = registerInstance(createInstance("/first", "/first/pages"));
  const second = registerInstance(createInstance("/second", "/second/pages"));
  let resolveFirst!: () => void;
  let resolveSecond!: () => void;
  const firstPending = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const secondPending = new Promise<void>((resolve) => {
    resolveSecond = resolve;
  });
  withInstance(first, () => pendingISRRevalidations().set("/page", firstPending));
  withInstance(second, () => pendingISRRevalidations().set("/page", secondPending));

  try {
    let settled = false;
    const waiting = waitForPendingISRRevalidations().then(() => {
      settled = true;
    });
    await Bun.sleep(5);
    expect(settled).toBe(false);

    resolveFirst();
    resolveSecond();
    await waiting;
  } finally {
    resolveFirst();
    resolveSecond();
    __clearInstanceRegistry();
  }
});
