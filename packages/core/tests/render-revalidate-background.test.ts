import { test } from "bun:test";
import { join as joinPath } from "node:path";

const script = `
const { mock } = await import("bun:test");
mock.module("evlog/elysia", () => ({
  evlog: () => (app) => app,
  useLogger: () => ({ set() {} }),
}));

const { join } = await import("node:path");
const { notFound } = await import("./packages/core/src/shared/not-found.ts");
const { __resetCacheState, isrCache } = await import("./packages/core/src/server/cache/index.ts");
const { handleISR } = await import("./packages/core/src/server/render/index.ts");
const { scanPages } = await import("./packages/core/src/server/router/index.ts");
const { __setDevMode } = await import("./packages/core/src/server/runtime-env.ts");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createMockLoaderContext(overrides = {}) {
  return {
    cookie: {},
    headers: {},
    params: {},
    path: "/test",
    query: {},
    redirect: (url) => new Response(null, { headers: { Location: url }, status: 302 }),
    request: new Request("http://localhost/test"),
    set: { headers: {} },
    ...overrides,
  };
}

async function waitForBackground(predicate, message) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

__setDevMode(false);
const result = await scanPages(join(process.cwd(), "packages/core/tests/fixtures/pages"));
const isrRoute = result.routes.find((route) => route.pattern === "/isr-page");
assert(isrRoute, "Route /isr-page not found");
const root = result.root;

__resetCacheState();
let staleHtml = "<html>stale-redirect</html>";
isrCache.set("/isr-page/redirect", { generatedAt: 0, html: staleHtml, revalidate: 60 });
let revalidationAttempts = 0;
let route = {
  ...isrRoute,
  page: {
    ...isrRoute.page,
    loader: () => {
      revalidationAttempts += 1;
      throw new Response(null, { headers: { Location: "/foo" }, status: 302 });
    },
  },
  pattern: "/isr-page/redirect",
};
let html = await handleISR(route, createMockLoaderContext({ path: "/isr-page/redirect" }), root, "");
assert(html === staleHtml, "redirect revalidation returns stale html");
await waitForBackground(() => revalidationAttempts === 1, "redirect revalidation did not settle");
assert(isrCache.get("/isr-page/redirect")?.html === staleHtml, "redirect revalidation keeps cache");

__resetCacheState();
staleHtml = "<html>stale-error</html>";
isrCache.set("/isr-page/error", { generatedAt: 0, html: staleHtml, revalidate: 60 });
revalidationAttempts = 0;
route = {
  ...isrRoute,
  page: {
    ...isrRoute.page,
    loader: () => {
      revalidationAttempts += 1;
      throw new Error("bg-revalidation-boom");
    },
  },
  pattern: "/isr-page/error",
};
html = await handleISR(route, createMockLoaderContext({ path: "/isr-page/error" }), root, "");
assert(html === staleHtml, "error revalidation returns stale html");
await waitForBackground(() => revalidationAttempts === 1, "error revalidation did not settle");
assert(isrCache.get("/isr-page/error")?.html === staleHtml, "error revalidation keeps cache");

__resetCacheState();
staleHtml = "<html>stale-not-found</html>";
isrCache.set("/isr-page/not-found", { generatedAt: 0, html: staleHtml, revalidate: 60 });
route = {
  ...isrRoute,
  page: {
    ...isrRoute.page,
    loader: () => notFound({ message: "gone" }),
  },
  pattern: "/isr-page/not-found",
};
html = await handleISR(route, createMockLoaderContext({ path: "/isr-page/not-found" }), root, "");
assert(html === staleHtml, "not-found revalidation returns stale html");
await waitForBackground(() => !isrCache.has("/isr-page/not-found"), "not-found revalidation did not invalidate cache");
assert(!isrCache.has("/isr-page/not-found"), "not-found revalidation invalidates cache");
const missCtx = createMockLoaderContext({ path: "/isr-page/not-found" });
await handleISR(route, missCtx, root, "");
assert(missCtx.set.status === 404, "not-found miss sets status");
`;

test("ISR background revalidation scenarios", () => {
  const proc = Bun.spawnSync({
    cmd: ["bun", "--preload", "./tests/setup.ts", "-e", script],
    cwd: joinPath(import.meta.dir, "../../.."),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      [
        `ISR background revalidation subprocess exited with ${proc.exitCode}`,
        new TextDecoder().decode(proc.stdout),
        new TextDecoder().decode(proc.stderr),
      ].join("\n")
    );
  }
});
