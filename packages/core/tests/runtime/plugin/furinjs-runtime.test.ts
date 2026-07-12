import { expect, test } from "bun:test";

const TESTS_DIR_SUFFIX_RE = /\/tests(?:\/.*)?$/;

test("furin() production runtime resolution scenarios", () => {
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Elysia } from "elysia";
import { furin } from "./src/furin.ts";
import { revalidateTag } from "./src/server/auto-invalidate/index.ts";
import { __resetCacheState, getSSGCache, ssgCache } from "./src/server/cache/index.ts";
import { __resetCompileContext, __setCompileContext } from "./src/server/internal.ts";
import { getProductionTemplate, setProductionTemplatePath } from "./src/server/render/template.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
import { createTmpApp } from "./tests/support/app-fixtures.ts";

const tmpApps = [];
const originalCwd = process.cwd();
const originalArgv = process.argv.slice();
const originalPath = process.env.PATH;
const originalClientDir = process.env.FURIN_CLIENT_DIR;
const originalURL = globalThis.URL;

function rememberTmpApp(app) {
  tmpApps.push(app);
  return app;
}

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

function assertIncludes(actual, expected, message) {
  if (!actual.includes(expected)) {
    throw new Error(message + ": expected " + JSON.stringify(actual) + " to include " + JSON.stringify(expected));
  }
}

function assertInstanceOf(actual, expected, message) {
  assert(actual instanceof expected, message);
}

async function assertRejectsToThrow(promise, expected, message) {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof Error, message + ": rejected with a non-Error value");
    assertIncludes(error.message, expected, message);
    return;
  }
  throw new Error(message + ": expected rejection");
}

async function setCompileContext(appPath, embedded) {
  const rootPath = join(appPath, "src/pages/root.tsx");
  const indexPath = join(appPath, "src/pages/index.tsx");
  const [rootMod, indexMod] = await Promise.all([import(rootPath), import(indexPath)]);

  __setCompileContext({
    modules: {
      [rootPath]: rootMod,
      [indexPath]: indexMod,
    },
    rootConventions: {},
    rootPath,
    routeMetadata: {
      [indexPath]: { segmentBoundaries: [] },
    },
    routes: [{ mode: "ssg", path: indexPath, pattern: "/" }],
    ...(embedded ? { embedded } : {}),
  });
}

function resetState() {
  __setDevMode(true);
  setProductionTemplatePath(null);
  __resetCacheState();
  __resetCompileContext();
  process.chdir(originalCwd);
  process.argv.length = 0;
  process.argv.push(...originalArgv);
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  if (originalClientDir === undefined) {
    delete process.env.FURIN_CLIENT_DIR;
  } else {
    process.env.FURIN_CLIENT_DIR = originalClientDir;
  }
  globalThis.URL = originalURL;
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
}

try {
  resetState();
  let app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  let clientDir = join(app.path, "custom-client");
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(join(clientDir, "index.html"), "<html>custom</html>");
  process.env.FURIN_CLIENT_DIR = "custom-client";

  await setCompileContext(app.path);
  let instance = await furin({ pagesDir: join(app.path, "src/pages") });

  assertInstanceOf(instance, Elysia, "custom client returns an Elysia instance");
  assertIncludes(getProductionTemplate(), "custom", "custom client template should be loaded");

  resetState();
  app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);
  process.env.FURIN_CLIENT_DIR = "missing-client";

  await setCompileContext(app.path);
  await assertRejectsToThrow(
    furin({ pagesDir: join(app.path, "src/pages") }),
    "No pre-built assets found",
    "missing client directory should reject"
  );

  resetState();
  app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  let moduleRoot = join(app.path, "module-home");
  let moduleClientDir = join(moduleRoot, "client");
  mkdirSync(moduleClientDir, { recursive: true });
  writeFileSync(join(moduleClientDir, "index.html"), "<html>module-client</html>");

  let fakeModuleUrl = pathToFileURL(join(moduleRoot, "furin.ts")).href;
  class FakeModuleURL extends originalURL {
    constructor() {
      super(fakeModuleUrl);
    }
  }
  globalThis.URL = FakeModuleURL;
  process.argv.length = 0;
  process.argv.push("bun", "missing");
  process.env.PATH = "";

  await setCompileContext(app.path);
  instance = await furin({ pagesDir: join(app.path, "src/pages") });
  assertInstanceOf(instance, Elysia, "module client returns an Elysia instance");
  assertIncludes(getProductionTemplate(), "module-client", "module client template should be loaded");

  resetState();
  app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  let binDir = join(app.path, "bin");
  let serverPath = join(binDir, "server");
  clientDir = join(binDir, "client");
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(serverPath, "");
  writeFileSync(join(clientDir, "index.html"), "<html>argv-client</html>");

  class FakeHttpURL extends originalURL {
    constructor() {
      super("http://example.com");
    }
  }
  globalThis.URL = FakeHttpURL;
  process.argv.length = 0;
  process.argv.push("bun", serverPath);
  process.env.PATH = "";

  await setCompileContext(app.path);
  instance = await furin({ pagesDir: join(app.path, "src/pages") });
  assertInstanceOf(instance, Elysia, "argv client returns an Elysia instance");
  assertIncludes(getProductionTemplate(), "argv-client", "argv client template should be loaded");

  resetState();
  app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  binDir = join(app.path, "bin");
  const binaryName = "furin-server";
  const binaryPath = join(binDir, binaryName);
  clientDir = join(binDir, "client");
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(binaryPath, "");
  writeFileSync(join(clientDir, "index.html"), "<html>path-client</html>");

  class FakeBunfsURL extends originalURL {
    constructor() {
      super("file:///$bunfs/furin.ts");
    }
  }
  globalThis.URL = FakeBunfsURL;
  process.argv.length = 0;
  process.argv.push("bun", binaryName);
  process.env.PATH = binDir;

  await setCompileContext(app.path);
  instance = await furin({ pagesDir: join(app.path, "src/pages") });
  assertInstanceOf(instance, Elysia, "PATH client returns an Elysia instance");
  assertIncludes(getProductionTemplate(), "path-client", "PATH client template should be loaded");

  resetState();
  app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  const fallbackDir = join(app.path, ".furin/build/bun/client");
  mkdirSync(fallbackDir, { recursive: true });
  writeFileSync(join(fallbackDir, "index.html"), "<html>fallback-client</html>");

  globalThis.URL = FakeHttpURL;
  process.argv.length = 0;
  process.argv.push("bun", "missing");
  process.env.PATH = "";

  await setCompileContext(app.path);
  instance = await furin({ pagesDir: join(app.path, "src/pages") });
  assertInstanceOf(instance, Elysia, "fallback client returns an Elysia instance");
  assertIncludes(getProductionTemplate(), "fallback-client", "fallback client template should be loaded");

  resetState();
  app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  clientDir = join(app.path, "client");
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(join(clientDir, "index.html"), "<html><!--ssr-outlet--></html>");
  process.env.FURIN_CLIENT_DIR = "client";

  let rootPath = join(app.path, "src/pages/root.tsx");
  let indexPath = join(app.path, "src/pages/index.tsx");
  let [rootMod, indexMod] = await Promise.all([import(rootPath), import(indexPath)]);
  __setCompileContext({
    modules: {
      [rootPath]: rootMod,
      [indexPath]: indexMod,
    },
    rootConventions: {},
    rootPath,
    routeMetadata: {
      [indexPath]: { segmentBoundaries: [] },
    },
    routes: [{ mode: "ssg", path: indexPath, pattern: "/" }],
    ssgCache: {
      "/": {
        cachedAt: 123,
        html: "<html>prebuilt</html>",
        ndjson: "{}\\n",
        status: 200,
      },
    },
  });

  instance = await furin({ pagesDir: join(app.path, "src/pages") });
  assertInstanceOf(instance, Elysia, "embedded SSG returns an Elysia instance");
  assertEqual(getSSGCache("/")?.html, "<html>prebuilt</html>", "embedded SSG cache should load");

  resetState();
  app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  clientDir = join(app.path, "client");
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(join(clientDir, "index.html"), "<html><!--ssr-outlet--></html>");
  process.env.FURIN_CLIENT_DIR = "client";

  rootPath = join(app.path, "src/pages/root.tsx");
  indexPath = join(app.path, "src/pages/index.tsx");
  [rootMod, indexMod] = await Promise.all([import(rootPath), import(indexPath)]);
  __setCompileContext({
    modules: {
      [rootPath]: rootMod,
      [indexPath]: indexMod,
    },
    rootConventions: {},
    rootPath,
    routeMetadata: {
      [indexPath]: { segmentBoundaries: [] },
    },
    routes: [{ mode: "ssg", path: indexPath, pattern: "/" }],
    ssgCache: {
      "/": {
        cachedAt: 123,
        html: "<html>prebuilt</html>",
        ndjson: "{}\\n",
        status: 200,
        tags: ["boards"],
      },
    },
  });

  await furin({ pagesDir: join(app.path, "src/pages") });
  assertEqual(revalidateTag("boards"), true, "embedded tag should revalidate");
  assertEqual(ssgCache.has("/"), false, "tag revalidation should clear SSG cache");

  resetState();
  app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  clientDir = join(app.path, "client");
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(join(clientDir, "index.html"), "<html>cwd-client</html>");
  globalThis.URL = FakeHttpURL;
  process.argv.length = 0;
  process.argv.push("bun", "missing");
  process.env.PATH = "";

  await setCompileContext(app.path);
  instance = await furin({ pagesDir: join(app.path, "src/pages") });
  assertInstanceOf(instance, Elysia, "cwd client returns an Elysia instance");
  assertIncludes(getProductionTemplate(), "cwd-client", "cwd client template should be loaded");

  resetState();
  app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  await setCompileContext(app.path, { assets: {}, template: "" });
  await assertRejectsToThrow(
    furin({ pagesDir: join(app.path, "src/pages") }),
    "HTML template",
    "missing embedded HTML template should reject"
  );

  resetState();
  app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  const templatePath = join(app.path, "template.html");
  const clientAsset = join(app.path, "client.js");
  const publicAsset = join(app.path, "logo.png");
  writeFileSync(templatePath, "<html><!--ssr-outlet--></html>");
  writeFileSync(clientAsset, "console.log('client');");
  writeFileSync(publicAsset, "logo");

  await setCompileContext(app.path, {
    assets: {
      "/_client/app.js": clientAsset,
      "/public/logo.png": publicAsset,
    },
    template: templatePath,
  });

  instance = await furin({ pagesDir: join(app.path, "src/pages") });
  const okClient = await instance.handle(new Request("http://furin/_client/app.js"));
  const okPublic = await instance.handle(new Request("http://furin/public/logo.png"));
  const missClient = await instance.handle(new Request("http://furin/_client/missing.js"));
  const missPublic = await instance.handle(new Request("http://furin/public/missing.png"));

  assertEqual(okClient.status, 200, "embedded client asset should be served");
  assertEqual(okPublic.status, 200, "embedded public asset should be served");
  assertEqual(missClient.status, 404, "missing embedded client asset should 404");
  assertEqual(missPublic.status, 404, "missing embedded public asset should 404");
} finally {
  resetState();
}
process.exit(0);
`,
    ],
    cwd: import.meta.dir.replace(TESTS_DIR_SUFFIX_RE, ""),
    stderr: "pipe",
    stdout: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(
      [
        `furin runtime subprocess exited with ${proc.exitCode}`,
        new TextDecoder().decode(proc.stdout),
        new TextDecoder().decode(proc.stderr),
      ].join("\n")
    );
  }

  expect(proc.exitCode).toBe(0);
});
