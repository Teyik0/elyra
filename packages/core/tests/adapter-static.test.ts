import { test } from "bun:test";
import { join as joinPath } from "node:path";

const script = `
const { existsSync, readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { buildStaticTarget } = await import("./packages/core/src/adapter/static.ts");
const { __resetCacheState } = await import("./packages/core/src/server/cache/index.ts");
const { __resetTemplateState } = await import("./packages/core/src/server/render/template.ts");
const { scanPages } = await import("./packages/core/src/server/router/index.ts");
const { __setDevMode } = await import("./packages/core/src/server/runtime-env.ts");
const { createTmpApp } = await import("./packages/core/tests/helpers/tmp-app.ts");
const { withBuildStub } = await import("./packages/core/tests/helpers/with-build-stub.ts");

const SSR_STATIC_RE = /SSR.*static/i;
const BASEPATH_RE = /basePath must start with/;
const UNSAFE_DIR_RE = /unsafe to delete/;
const PRERENDER_FAIL_RE = /route\\(s\\) failed to pre-render/;
const UNSAFE_PATH_RE = /unsafe output path/;
const REQUEST_LOADER_STATIC_RE = /requestLoader.*static/i;

__setDevMode(false);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function assertRejects(fn, regex, message) {
  try {
    await fn();
  } catch (error) {
    assert(error instanceof Error, message + ": expected Error");
    assert(regex.test(error.message), message + ": " + error.message);
    return error;
  }
  throw new Error(message + ": expected rejection");
}

function makeApp(fixtureName = "cli-app") {
  __resetCacheState();
  __resetTemplateState();
  return createTmpApp(fixtureName);
}

async function scanApp(app) {
  const scanned = await scanPages(join(app.path, "src/pages"));
  return { ...scanned, distDir: join(app.path, "dist") };
}

async function runStaticBuild(fixtureName = "cli-app", extra = {}) {
  const app = makeApp(fixtureName);
  const { root, routes, distDir } = await scanApp(app);
  const manifest = await withBuildStub(() =>
    buildStaticTarget(routes, app.path, join(app.path, ".furin/build"), root, {
      staticConfig: { outDir: distDir },
      target: "static",
      ...extra,
    })
  );
  return { app, distDir, manifest, root, routes };
}

const root = {
  path: "/root.tsx",
  route: { __type: "FURIN_ROUTE" },
};
const requestRoute = {
  mode: "ssg",
  page: { requestLoader: async () => ({ userId: "private" }) },
  path: "/index.tsx",
  pattern: "/",
  routeChain: [],
  segmentBoundaries: [],
};
await assertRejects(
  () => buildStaticTarget([requestRoute], "/tmp/furin-static-test", "/tmp/furin-static-test/.build", root, { target: "static" }),
  REQUEST_LOADER_STATIC_RE,
  "requestLoader route is rejected"
);
await assertRejects(
  () => buildStaticTarget([], "/tmp/furin-static-test", "/tmp/furin-static-test/.build", { ...root, route: { ...root.route, requestLoader: async () => ({ userId: "private" }) } }, { target: "static" }),
  REQUEST_LOADER_STATIC_RE,
  "root requestLoader is rejected"
);

let result = await runStaticBuild();
assert(existsSync(join(result.distDir, "index.html")), "B1 index.html exists");
assert(existsSync(join(result.distDir, "blog/hello-world/index.html")), "B2 dynamic static file exists");
assert(existsSync(join(result.distDir, "404.html")), "B7 404 exists");
let html = readFileSync(join(result.distDir, "blog/hello-world/index.html"), "utf8");
assert(html.includes("<!DOCTYPE html>"), "B6 dynamic HTML is complete");
assert(existsSync(join(result.distDir, "__furin_data.ndjson")), "root static data exists");
assert(existsSync(join(result.distDir, "blog/hello-world/__furin_data.ndjson")), "dynamic static data exists");

const { parseDeferredNdjson } = await import("./packages/core/src/shared/deferred-ndjson.ts");
const ndjsonText = readFileSync(join(result.distDir, "blog/hello-world/__furin_data.ndjson"), "utf8");
const stream = new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(ndjsonText));
    controller.close();
  },
});
const parsed = await parseDeferredNdjson(stream, undefined);
assert(parsed.syncData instanceof Object, "static NDJSON parses");

let app = makeApp("cli-app-ssr");
let scanned = await scanApp(app);
await assertRejects(
  () => withBuildStub(() => buildStaticTarget(scanned.routes, app.path, join(app.path, ".furin/build"), scanned.root, { staticConfig: { outDir: scanned.distDir }, target: "static" })),
  SSR_STATIC_RE,
  "B3 SSR route rejects by default"
);

app = makeApp("cli-app-ssr");
scanned = await scanApp(app);
let errorMessage = "";
try {
  await withBuildStub(() => buildStaticTarget(scanned.routes, app.path, join(app.path, ".furin/build"), scanned.root, { staticConfig: { outDir: scanned.distDir }, target: "static" }));
} catch (error) {
  errorMessage = String(error);
}
assert(errorMessage.includes("/dashboard"), "B9 error lists SSR dashboard");

app = makeApp("cli-app-ssr");
scanned = await scanApp(app);
await withBuildStub(() =>
  buildStaticTarget(scanned.routes, app.path, join(app.path, ".furin/build"), scanned.root, {
    staticConfig: { onSSR: "skip", outDir: scanned.distDir },
    target: "static",
  })
);
assert(existsSync(join(scanned.distDir, "index.html")), "B4 SSG page rendered");
assert(!existsSync(join(scanned.distDir, "dashboard/index.html")), "B4 SSR page skipped");

app = makeApp("cli-app");
scanned = await scanApp(app);
let patchedRoutes = scanned.routes.map((route) =>
  route.pattern.includes(":") ? { ...route, page: { ...route.page, staticParams: undefined } } : route
);
await withBuildStub(() =>
  buildStaticTarget(patchedRoutes, app.path, join(app.path, ".furin/build"), scanned.root, {
    staticConfig: { outDir: scanned.distDir },
    target: "static",
  })
);
assert(existsSync(join(scanned.distDir, "index.html")), "B5 static route rendered");
assert(!existsSync(join(scanned.distDir, "blog/hello-world/index.html")), "B5 dynamic route skipped");

result = await runStaticBuild("cli-app", {
  staticConfig: { basePath: "/furin", outDir: "dist" },
});
html = readFileSync(join(result.distDir, "index.html"), "utf8");
assert(html.includes("/furin/_client/"), "B8 basePath prefixes client assets");
assert(!html.includes('"/_client/'), "B8 root client path absent");

app = makeApp("cli-app");
scanned = await scanApp(app);
await assertRejects(
  () => buildStaticTarget(scanned.routes, app.path, join(app.path, ".furin/build"), scanned.root, { staticConfig: { basePath: "sub-path", outDir: scanned.distDir }, target: "static" }),
  BASEPATH_RE,
  "B10 bad basePath rejects"
);

result = await runStaticBuild("cli-app", {
  staticConfig: { basePath: "/furin/", outDir: "dist" },
});
html = readFileSync(join(result.distDir, "index.html"), "utf8");
assert(html.includes("/furin/_client/"), "B11 trailing slash normalized");
assert(!html.includes("/furin//_client/"), "B11 double slash absent");

app = makeApp("cli-app");
scanned = await scanApp(app);
await assertRejects(
  () => buildStaticTarget(scanned.routes, app.path, join(app.path, ".furin/build"), scanned.root, { staticConfig: { outDir: "/" }, target: "static" }),
  UNSAFE_DIR_RE,
  "B12 filesystem root rejected"
);
await assertRejects(
  () => buildStaticTarget(scanned.routes, app.path, join(app.path, ".furin/build"), scanned.root, { staticConfig: { outDir: app.path }, target: "static" }),
  UNSAFE_DIR_RE,
  "B13 rootDir outDir rejected"
);
await assertRejects(
  () => buildStaticTarget(scanned.routes, app.path, join(app.path, ".furin/build"), scanned.root, { staticConfig: { outDir: join(app.path, "..") }, target: "static" }),
  UNSAFE_DIR_RE,
  "B14 ancestor outDir rejected"
);

app = makeApp("cli-app");
scanned = await scanApp(app);
const baseRoute = scanned.routes.find((route) => route.mode === "ssg" && !route.pattern.includes(":"));
assert(baseRoute, "static fixture route exists");
let route = {
  ...baseRoute,
  page: {
    ...baseRoute.page,
    loader: () => Promise.reject(new Response(null, { headers: { Location: "/home" }, status: 302 })),
  },
  pattern: "/redirect-me",
};
let manifest = await withBuildStub(() =>
  buildStaticTarget([route, ...scanned.routes.filter((item) => item.mode === "ssg")], app.path, join(app.path, ".furin/build"), scanned.root, {
    staticConfig: { outDir: scanned.distDir },
    target: "static",
  })
);
assert(!manifest.renderedRoutes.includes("/redirect-me"), "B15 redirect route not rendered");
assert(!manifest.skippedRoutes.includes("/redirect-me"), "B15 redirect route not skipped");
assert(!existsSync(join(scanned.distDir, "redirect-me/index.html")), "B15 redirect file absent");

route = {
  ...baseRoute,
  page: {
    ...baseRoute.page,
    loader: () => Promise.reject(new Error("prerender-boom")),
  },
  pattern: "/will-fail",
};
manifest = await withBuildStub(() =>
  buildStaticTarget([route, ...scanned.routes.filter((item) => item.mode === "ssg")], app.path, join(app.path, ".furin/build"), scanned.root, {
    staticConfig: { onSSR: "skip", outDir: scanned.distDir },
    target: "static",
  })
);
assert(manifest.skippedRoutes.includes("/will-fail"), "B16 failed route skipped");
assert(!manifest.renderedRoutes.includes("/will-fail"), "B16 failed route not rendered");
await assertRejects(
  () => withBuildStub(() => buildStaticTarget([route, ...scanned.routes.filter((item) => item.mode === "ssg")], app.path, join(app.path, ".furin/build"), scanned.root, { staticConfig: { outDir: scanned.distDir }, target: "static" })),
  PRERENDER_FAIL_RE,
  "B17 prerender failure rejects"
);

const dynamicRoute = scanned.routes.find((item) => item.pattern.includes(":"));
assert(dynamicRoute, "dynamic fixture route exists");
patchedRoutes = scanned.routes.map((item) =>
  item.pattern === dynamicRoute.pattern
    ? { ...item, page: { ...item.page, staticParams: () => Promise.reject(new Error("staticParams-boom")) } }
    : item
);
manifest = await withBuildStub(() =>
  buildStaticTarget(patchedRoutes, app.path, join(app.path, ".furin/build"), scanned.root, {
    staticConfig: { outDir: scanned.distDir },
    target: "static",
  })
);
assert(manifest.skippedRoutes.includes(dynamicRoute.pattern), "B18 staticParams failure skipped");

patchedRoutes = scanned.routes.map((item) =>
  item.pattern === dynamicRoute.pattern
    ? { ...item, page: { ...item.page, staticParams: async () => [{ slug: "../../etc/passwd" }] } }
    : item
);
await assertRejects(
  () => withBuildStub(() => buildStaticTarget(patchedRoutes, app.path, join(app.path, ".furin/build"), scanned.root, { staticConfig: { outDir: scanned.distDir }, target: "static" })),
  UNSAFE_PATH_RE,
  "B19 path traversal rejected"
);
`;

test("buildStaticTarget scenarios", () => {
  const proc = Bun.spawnSync({
    cmd: ["bun", "--preload", "./tests/setup.ts", "-e", script],
    cwd: joinPath(import.meta.dir, "../../.."),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      [
        `buildStaticTarget subprocess exited with ${proc.exitCode}`,
        new TextDecoder().decode(proc.stdout),
        new TextDecoder().decode(proc.stderr),
      ].join("\n")
    );
  }
});
