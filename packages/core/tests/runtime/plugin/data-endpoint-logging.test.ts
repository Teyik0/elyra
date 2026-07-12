import { expect, test } from "bun:test";

const TESTS_DIR_SUFFIX_RE = /\/tests(?:\/.*)?$/;

test("GET /_furin/data wide event enrichment scenarios", () => {
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `
import { expect, mock } from "bun:test";
import { join } from "node:path";

const setSpy = mock();

mock.module("evlog/elysia", () => ({
  evlog: () => (app) => app,
  useLogger: () => ({ set: setSpy }),
}));
mock.module("evlog", () => ({
  createLogger: () => ({
    emit: () => null,
    error: () => {},
    fork: (_label, fn) => fn(),
    getContext: () => ({}),
    info: () => {},
    set: () => {},
    warn: () => {},
  }),
  initLogger: () => {},
  log: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
  useLogger: () => ({ error() {}, info() {}, set() {}, warn() {} }),
}));

const { Elysia } = await import("elysia");
const { createDataEndpoint, scanPages } = await import("./src/server/router/index.ts");
const { __setDevMode } = await import("./src/server/runtime-env.ts");

const fixturesDir = join(import.meta.dir, "tests/fixtures/pages/default");

__setDevMode(false);

setSpy.mockClear();
let scanned = await scanPages(fixturesDir);
let app = new Elysia().use(createDataEndpoint(scanned.routes));

await app.handle(new Request("http://localhost/_furin/data?path=%2Fdynamic%2F42"));

const merged = setSpy.mock.calls.reduce(
  (acc, [arg]) => Object.assign(acc, arg),
  {}
);
expect(merged.path).toBe("/dynamic/42");
expect(merged.routePattern).toBe("/dynamic/:id");

setSpy.mockClear();
scanned = await scanPages(fixturesDir);
app = new Elysia().use(createDataEndpoint(scanned.routes));

const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fnope%2Fnowhere"));

expect(res.status).toBe(404);
const enrichingCall = setSpy.mock.calls.find(([arg]) => arg.path === "/nope/nowhere");
expect(enrichingCall).toBeDefined();
`,
    ],
    cwd: import.meta.dir.replace(TESTS_DIR_SUFFIX_RE, ""),
    stderr: "pipe",
    stdout: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(
      [
        `data endpoint logging subprocess exited with ${proc.exitCode}`,
        new TextDecoder().decode(proc.stdout),
        new TextDecoder().decode(proc.stderr),
      ].join("\n")
    );
  }

  expect(proc.exitCode).toBe(0);
});
