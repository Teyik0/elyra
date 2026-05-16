import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("evlog/elysia", () => ({
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
  useLogger: () => ({ set() {} }),
  evlog: () => (app: unknown) => app,
}));
mock.module("evlog", () => ({
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stubs
  log: { warn: () => {}, error: () => {}, info: () => {}, set: () => {} },
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stubs
  createLogger: () => ({ set() {}, error() {}, emit() {}, info() {}, warn() {} }),
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
  useLogger: () => ({ set() {} }),
}));

import {
  __resetDeferredStaticWarnings,
  warnDeferredInStaticContext,
} from "../src/render/deferred-warn";

const DEFER_RE = /defer/i;

describe("warnDeferredInStaticContext()", () => {
  let warnSpy: ReturnType<typeof mock>;
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    __resetDeferredStaticWarnings();
    originalWarn = console.warn;
    warnSpy = mock(() => undefined);
    console.warn = warnSpy;
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  test("émet un warning une fois par route+mode", () => {
    warnDeferredInStaticContext("/blog/[slug]", "ssg");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const args = warnSpy.mock.calls[0] as unknown[];
    expect(String(args[0])).toContain("/blog/[slug]");
    expect(String(args[0])).toContain("ssg");
    expect(String(args[0])).toMatch(DEFER_RE);
  });

  test("ne ré-émet pas pour la même route+mode (dédupliqué)", () => {
    warnDeferredInStaticContext("/blog/[slug]", "ssg");
    warnDeferredInStaticContext("/blog/[slug]", "ssg");
    warnDeferredInStaticContext("/blog/[slug]", "ssg");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test("ré-émet pour le même pattern avec un mode différent", () => {
    warnDeferredInStaticContext("/blog/[slug]", "ssg");
    warnDeferredInStaticContext("/blog/[slug]", "isr");
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  test("ré-émet pour des patterns distincts", () => {
    warnDeferredInStaticContext("/a", "ssg");
    warnDeferredInStaticContext("/b", "ssg");
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});
