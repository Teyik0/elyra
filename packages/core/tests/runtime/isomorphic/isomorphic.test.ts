import { describe, expect, test } from "bun:test";
import { createIsomorphicFn } from "../../../src/isomorphic.ts";

describe("createIsomorphicFn server fallback", () => {
  test("uses the server branch regardless of chain order", () => {
    const serverFirst = createIsomorphicFn()
      .server(() => "server")
      .client(() => "client");
    const clientFirst = createIsomorphicFn()
      .client(() => "client")
      .server(() => "server");

    expect(serverFirst()).toBe("server");
    expect(clientFirst()).toBe("server");
  });

  test("uses a no-op when no server branch exists", () => {
    const clientOnly = createIsomorphicFn().client(() => "client");

    expect(clientOnly()).toBeUndefined();
    expect(createIsomorphicFn()()).toBeUndefined();
  });

  test("fails clearly when an uncompiled function reaches the browser", () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });

    try {
      const clientOnly = createIsomorphicFn().client(() => "client");
      expect(() => clientOnly()).toThrow("strip-plugin");
    } finally {
      if (previousWindow) {
        Object.defineProperty(globalThis, "window", previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });
});
