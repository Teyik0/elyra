import { test } from "bun:test";
import { join as joinPath } from "node:path";

const script = `
const { mock } = await import("bun:test");
mock.module("evlog/elysia", () => ({
  evlog: () => (app) => app,
  useLogger: () => ({ set() {} }),
}));

const { join } = await import("node:path");
const { createElement, Suspense } = await import("react");
const { defer } = await import("./src/client.ts");
const { renderSSR } = await import("./src/server/render/index.ts");
const { setProductionTemplateContent } = await import("./src/server/render/template.ts");
const { scanPages } = await import("./src/server/router/index.ts");
const { __setDevMode } = await import("./src/server/runtime-env.ts");
const { Await } = await import("./src/shared/await.tsx");

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

async function getSsrFixtureRoute() {
  const result = await scanPages(join(process.cwd(), "tests/fixtures/pages"));
  const ssrRoute = result.routes.find((route) => route.pattern === "/ssr-page");
  assert(ssrRoute, "Route /ssr-page not found");
  return { root: result.root, ssrRoute };
}

__setDevMode(false);

let fixture = await getSsrFixtureRoute();
let customRoute = {
  ...fixture.ssrRoute,
  page: {
    ...fixture.ssrRoute.page,
    loader: () =>
      defer({
        slow: new Promise((resolve) => setTimeout(() => resolve("slow-value"), 80)),
        fast: new Promise((resolve) => setTimeout(() => resolve("fast-value"), 10)),
      }),
  },
};
let response = await renderSSR(
  customRoute,
  createMockLoaderContext({ path: "/ssr-page" }),
  fixture.root,
  undefined
);
let html = await response.text();
let fastIdx = html.indexOf('window.__FURIN_DEFERRED__.resolve("fast"');
let slowIdx = html.indexOf('window.__FURIN_DEFERRED__.resolve("slow"');
assert(fastIdx > -1, "fast deferred chunk missing");
assert(slowIdx > -1, "slow deferred chunk missing");
assert(fastIdx < slowIdx, "deferred chunks must stream in settlement order");

setProductionTemplateContent(
  '<!DOCTYPE html><html><head><!--ssr-head--></head><body><div id="root"><!--ssr-outlet--></div><script type="module" src="/_hydrate.js"></script></body></html>'
);
fixture = await getSsrFixtureRoute();
customRoute = {
  ...fixture.ssrRoute,
  page: {
    ...fixture.ssrRoute.page,
    component: (props) => {
      const slow = props.slow;
      return createElement(
        Suspense,
        { fallback: createElement("span", null, "loading") },
        createElement(Await, {
          children: (value) => createElement("span", null, String(value)),
          resolve: slow,
        })
      );
    },
    loader: () =>
      defer({
        slow: new Promise((resolve) => setTimeout(() => resolve("done"), 50)),
      }),
  },
};
response = await renderSSR(
  customRoute,
  createMockLoaderContext({ path: "/ssr-page" }),
  fixture.root,
  undefined
);
html = await response.text();
assert(html.includes("done"), "resolved Suspense content missing");
assert(html.includes("window.__FURIN_DEFERRED__.resolve"), "deferred resolve script missing");
assert(
  !html.includes("Switched to client rendering because the server rendering aborted"),
  "React abort message leaked into SSR HTML"
);
`;

test("renderSSR deferred Suspense scenarios", () => {
  const proc = Bun.spawnSync({
    cmd: ["bun", "--preload", "../../tests/setup.ts", "-e", script],
    cwd: joinPath(import.meta.dir, ".."),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      [
        `renderSSR deferred Suspense subprocess exited with ${proc.exitCode}`,
        new TextDecoder().decode(proc.stdout),
        new TextDecoder().decode(proc.stderr),
      ].join("\n")
    );
  }
});
