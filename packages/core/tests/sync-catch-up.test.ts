import { describe, expect, test } from "bun:test";
import {
  createInvalidationRefresh,
  createSyncCatchUp,
} from "../src/client/router/sync-catch-up.ts";

describe("createSyncCatchUp", () => {
  test("initializes at the current cursor then applies every paginated change", async () => {
    const requestedAfter: Array<string | undefined> = [];
    const invalidations: string[][] = [];
    const pages = [
      { changes: [], cursor: "2", hasMore: false, reset: false },
      {
        changes: [{ cursor: "3", invalidations: ["/board"] }],
        cursor: "3",
        hasMore: true,
        reset: false,
      },
      {
        changes: [{ cursor: "4", invalidations: ["/sidebar:layout"] }],
        cursor: "4",
        hasMore: false,
        reset: false,
      },
    ];
    const sync = createSyncCatchUp({
      fetchPage: (after) => {
        requestedAfter.push(after);
        const page = pages.shift();
        if (!page) {
          throw new Error("Unexpected sync page request");
        }
        return Promise.resolve(page);
      },
      onInvalidations: (entries) => invalidations.push([...entries]),
    });

    await sync.initialize();
    await sync.catchUp();

    expect(requestedAfter).toEqual([undefined, "2", "3"]);
    expect(invalidations).toEqual([["/board"], ["/sidebar:layout"]]);
    expect(sync.cursor()).toBe("4");
  });

  test("recovers from cursor zero when initialization did not complete", async () => {
    const requestedAfter: Array<string | undefined> = [];
    const invalidations: string[] = [];
    const sync = createSyncCatchUp({
      fetchPage: (after) => {
        requestedAfter.push(after);
        return Promise.resolve({
          changes: [{ cursor: "8", invalidations: ["/:layout"] }],
          cursor: "8",
          hasMore: false,
          reset: true,
        });
      },
      onInvalidations: (entries) => invalidations.push(...entries),
    });

    await sync.catchUp();

    expect(requestedAfter).toEqual(["0"]);
    expect(invalidations).toEqual(["/:layout"]);
    expect(sync.cursor()).toBe("8");
  });
});

describe("createInvalidationRefresh", () => {
  test("coalesces refreshes and treats navigation aborts as expected", async () => {
    let calls = 0;
    let rejectRefresh: ((error: unknown) => void) | undefined;
    const errors: unknown[] = [];
    const refresh = createInvalidationRefresh({
      onError: (error) => errors.push(error),
      refresh: () => {
        calls += 1;
        return new Promise<void>((_resolve, reject) => {
          rejectRefresh = reject;
        });
      },
    });

    const first = refresh.run();
    const second = refresh.run();
    rejectRefresh?.(new DOMException("Navigation superseded", "AbortError"));

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(calls).toBe(1);
    expect(errors).toEqual([]);
  });
});
