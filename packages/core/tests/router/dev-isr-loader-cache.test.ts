import { expect, test } from "bun:test";

const CORE_DIR_SUFFIX_RE = /\/tests\/router$/;

const DEV_LOADER_CACHE_INTEGRATION = String.raw`
import { join } from "node:path";
import { Elysia } from "elysia";
import {
  __resetCacheState,
  __resetDevLoaderCacheState,
  getDevISRLoaderCache,
  getDevSSGLoaderCache,
  invalidateDevLoaderCacheBySource,
} from "./src/server/cache/index.ts";
import { registerDevPagePlugin } from "./src/server/dev-page-plugin.ts";
import { createDevInspectorPlugin } from "./src/server/dev-inspector.ts";
import { setProductionTemplateContent } from "./src/server/render/template.ts";
import { scanPages } from "./src/server/router/discovery.ts";
import { createRoutePlugin } from "./src/server/router/plugin.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";

const fixturesDir = join(process.cwd(), "tests/fixtures/pages");
const template =
  '<!DOCTYPE html><html><head><!--FURIN_HEAD--></head><body><div id="root"><!--FURIN_HTML--></div><!--FURIN_TAIL--></body></html>';
const timestampRe = /data-timestamp="(\d+)"/;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message + ": expected " + String(expected) + ", got " + String(actual));
  }
}

function prepareDevCacheTest() {
  __resetCacheState();
  __resetDevLoaderCacheState();
}

function getRoute(result, pattern, mode) {
  const route = result.routes.find((candidate) => candidate.pattern === pattern && candidate.mode === mode);
  if (!route) {
    throw new Error("No " + pattern + " fixture with mode=" + mode);
  }
  return route;
}

async function requestText(app, path) {
  const response = await app.handle(new Request("http://localhost" + path));
  assertEqual(response.status, 200, path + " should return 200");
  return response.text();
}

function timestampFrom(html) {
  const value = html.match(timestampRe)?.[1];
  assert(value !== undefined, "rendered HTML should contain data timestamp");
  return value;
}

__setDevMode(false);
setProductionTemplateContent(template);
registerDevPagePlugin();

{
  prepareDevCacheTest();
  const result = await scanPages(fixturesDir);
  const route = getRoute(result, "/isr-page", "isr");
  __setDevMode(true);
  try {
    const app = new Elysia().use(createRoutePlugin(route, result.root));
    const ts1 = timestampFrom(await requestText(app, "/isr-page"));
    await Bun.sleep(20);
    const ts2 = timestampFrom(await requestText(app, "/isr-page"));
    assertEqual(ts2, ts1, "ISR loader cache hit should preserve data");
  } finally {
    __setDevMode(false);
  }
}

{
  prepareDevCacheTest();
  const result = await scanPages(fixturesDir);
  const route = getRoute(result, "/isr-page", "isr");
  __setDevMode(true);
  try {
    const app = new Elysia().use(createRoutePlugin(route, result.root));
    const ts1 = timestampFrom(await requestText(app, "/isr-page"));
    const cacheKey = result.root.path + ":/isr-page";
    const cached = getDevISRLoaderCache(cacheKey);
    assert(cached !== undefined, "ISR cache should be populated");
    assert(cached.dependencies.includes(route.path), "ISR cache should include page dependency");
    assert(cached.dependencies.includes(result.root.path), "ISR cache should include root dependency");
    invalidateDevLoaderCacheBySource(route.path);
    assert(getDevISRLoaderCache(cacheKey) === undefined, "source invalidation should clear ISR cache");
    await Bun.sleep(20);
    const ts2 = timestampFrom(await requestText(app, "/isr-page"));
    assert(Number(ts2) > Number(ts1), "invalidated ISR cache should rerun loader");
  } finally {
    __setDevMode(false);
  }
}

{
  prepareDevCacheTest();
  const result = await scanPages(fixturesDir);
  const route = getRoute(result, "/isr-page", "isr");
  __setDevMode(true);
  try {
    const app = new Elysia().use(createRoutePlugin(route, result.root));
    const ts1 = timestampFrom(await requestText(app, "/isr-page"));
    const cacheKey = result.root.path + ":/isr-page";
    invalidateDevLoaderCacheBySource("/some/unrelated/file.tsx");
    assert(getDevISRLoaderCache(cacheKey) !== undefined, "unrelated source should not clear ISR cache");
    await Bun.sleep(20);
    const ts2 = timestampFrom(await requestText(app, "/isr-page"));
    assertEqual(ts2, ts1, "unrelated invalidation should preserve ISR cache");
  } finally {
    __setDevMode(false);
  }
}

{
  prepareDevCacheTest();
  const result = await scanPages(fixturesDir);
  const route = getRoute(result, "/isr-page", "isr");
  __setDevMode(true);
  try {
    const app = new Elysia().use(createRoutePlugin(route, result.root)).use(createDevInspectorPlugin());
    await requestText(app, "/isr-page");
    const response = await app.handle(new Request("http://localhost/__furin/_inspect/isr"));
    assertEqual(response.status, 200, "inspector should return 200");
    assert(response.headers.get("content-type")?.includes("application/json"), "inspector should return JSON");
    const body = await response.json();
    assertEqual(body.length, 1, "inspector should expose one ISR entry");
    const entry = body[0];
    assertEqual(entry.key, result.root.path + ":/isr-page", "inspector key should match cache key");
    assertEqual(entry.mode, "isr", "inspector mode should be isr");
    assertEqual(entry.isFresh, true, "inspector entry should be fresh");
    assertEqual(entry.revalidate, 60, "inspector revalidate should match route");
    assert(entry.dependencies.includes(route.path), "inspector should include page dependency");
    assert(entry.dependencies.includes(result.root.path), "inspector should include root dependency");
    assert(entry.dataPreview.timestamp !== undefined, "inspector should expose cached loader data");
  } finally {
    __setDevMode(false);
  }
}

{
  prepareDevCacheTest();
  const result = await scanPages(fixturesDir);
  const route = getRoute(result, "/ssg-loader-page", "ssg");
  __setDevMode(true);
  try {
    const app = new Elysia().use(createRoutePlugin(route, result.root));
    const ts1 = timestampFrom(await requestText(app, "/ssg-loader-page"));
    await Bun.sleep(20);
    const ts2 = timestampFrom(await requestText(app, "/ssg-loader-page"));
    assertEqual(ts2, ts1, "SSG loader cache hit should preserve data");
    const cached = getDevSSGLoaderCache(result.root.path + ":/ssg-loader-page");
    assertEqual(cached?.mode, "ssg", "SSG cache entry should be tagged as ssg");
    assertEqual(cached?.revalidate, Number.POSITIVE_INFINITY, "SSG cache should be indefinitely fresh");
  } finally {
    __setDevMode(false);
  }
}

{
  prepareDevCacheTest();
  const result = await scanPages(fixturesDir);
  const route = getRoute(result, "/ssg-loader-page", "ssg");
  __setDevMode(true);
  try {
    const app = new Elysia().use(createRoutePlugin(route, result.root));
    const ts1 = timestampFrom(await requestText(app, "/ssg-loader-page"));
    const cacheKey = result.root.path + ":/ssg-loader-page";
    const cached = getDevSSGLoaderCache(cacheKey);
    assert(cached !== undefined, "SSG cache should be populated");
    assert(cached.dependencies.includes(route.path), "SSG cache should include page dependency");
    assert(cached.dependencies.includes(result.root.path), "SSG cache should include root dependency");
    const outcome = invalidateDevLoaderCacheBySource(route.path);
    assertEqual(outcome.ssg, 1, "source invalidation should clear one SSG entry");
    assert(getDevSSGLoaderCache(cacheKey) === undefined, "source invalidation should clear SSG cache");
    await Bun.sleep(20);
    const ts2 = timestampFrom(await requestText(app, "/ssg-loader-page"));
    assert(Number(ts2) > Number(ts1), "invalidated SSG cache should rerun loader");
  } finally {
    __setDevMode(false);
  }
}

process.exit(0);
`;

test("dev ISR and SSG loader cache integration scenarios", () => {
  const proc = Bun.spawnSync({
    cmd: ["bun", "-e", DEV_LOADER_CACHE_INTEGRATION],
    cwd: import.meta.dir.replace(CORE_DIR_SUFFIX_RE, ""),
    stderr: "pipe",
    stdout: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(
      [
        `dev loader cache integration subprocess exited with ${proc.exitCode}`,
        new TextDecoder().decode(proc.stdout),
        new TextDecoder().decode(proc.stderr),
      ].join("\n")
    );
  }

  expect(proc.exitCode).toBe(0);
});
