import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

// Spy on the request-scoped logger's set() so we can verify the wide-event
// fields written by the /_furin/data handler.
const setSpy = mock();

mock.module("evlog/elysia", () => ({
  useLogger: () => ({ set: setSpy }),
  evlog: () => (app: unknown) => app,
}));
mock.module("evlog", () => ({
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stubs
  log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
  initLogger: () => {},
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stubs
  useLogger: () => ({ set() {}, info() {}, warn() {}, error() {} }),
  createLogger: () => ({
    // biome-ignore lint/suspicious/noEmptyBlockStatements: no-op stub
    set: () => {},
    // biome-ignore lint/suspicious/noEmptyBlockStatements: no-op stub
    error: () => {},
    // biome-ignore lint/suspicious/noEmptyBlockStatements: no-op stub
    info: () => {},
    // biome-ignore lint/suspicious/noEmptyBlockStatements: no-op stub
    warn: () => {},
    emit: () => null,
    getContext: () => ({}),
    fork: (_l: string, fn: () => unknown) => fn(),
  }),
}));

import { Elysia } from "elysia";
import { createDataEndpoint, scanPages } from "../src/router";
import { __setDevMode, IS_DEV } from "../src/runtime-env";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures/pages");

let originalDevMode: boolean;
beforeAll(() => {
  originalDevMode = IS_DEV;
  __setDevMode(false);
});
afterAll(() => __setDevMode(originalDevMode));

beforeEach(() => {
  setSpy.mockClear();
});

describe("GET /_furin/data — wide event enrichment", () => {
  test("rewrites path and routePattern on the wide event when the route matches", async () => {
    const { root, routes } = await scanPages(FIXTURES_DIR);
    const app = new Elysia().use(createDataEndpoint(routes, root));

    await app.handle(new Request("http://localhost/_furin/data?path=%2Fdynamic%2F42"));

    // The handler must enrich the request-scoped wide event with the *logical*
    // path (so console / drains show "GET /dynamic/42" instead of the
    // technical "/_furin/data") and the canonical routePattern (so traces can
    // be aggregated by route). The handler may apply these in one or several
    // set() calls — what matters is the merged result a drain would observe.
    const merged = setSpy.mock.calls.reduce<Record<string, unknown>>(
      (acc, [arg]) => Object.assign(acc, arg as Record<string, unknown>),
      {}
    );
    expect(merged.path).toBe("/dynamic/42");
    expect(merged.routePattern).toBe("/dynamic/:id");
  });

  test("still rewrites path on the wide event when no route matches (404)", async () => {
    const { root, routes } = await scanPages(FIXTURES_DIR);
    const app = new Elysia().use(createDataEndpoint(routes, root));

    const res = await app.handle(
      new Request("http://localhost/_furin/data?path=%2Fnope%2Fnowhere")
    );

    // Even on 404 we want logs to show the *logical* path the user navigated
    // to, so monitoring can spot SPA routing mismatches at a glance — not
    // every "GET /_furin/data 404" with no clue what was attempted.
    expect(res.status).toBe(404);
    const enrichingCall = setSpy.mock.calls.find(([arg]) => {
      const fields = arg as Record<string, unknown>;
      return fields.path === "/nope/nowhere";
    });
    expect(enrichingCall).toBeDefined();
  });
});
