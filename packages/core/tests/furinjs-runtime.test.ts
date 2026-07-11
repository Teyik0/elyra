import { expect, test } from "bun:test";

const TESTS_DIR_SUFFIX_RE = /\/tests$/;

test("furin() production runtime resolution scenarios", () => {
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `
import { expect } from "bun:test";
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
import { createTmpApp } from "./tests/helpers/tmp-app.ts";

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

  expect(instance).toBeInstanceOf(Elysia);
  expect(getProductionTemplate()).toContain("custom");

  resetState();
  app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);
  process.env.FURIN_CLIENT_DIR = "missing-client";

  await setCompileContext(app.path);
  await expect(furin({ pagesDir: join(app.path, "src/pages") })).rejects.toThrow(
    "No pre-built assets found"
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
  expect(instance).toBeInstanceOf(Elysia);
  expect(getProductionTemplate()).toContain("module-client");

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
  expect(instance).toBeInstanceOf(Elysia);
  expect(getProductionTemplate()).toContain("argv-client");

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
  expect(instance).toBeInstanceOf(Elysia);
  expect(getProductionTemplate()).toContain("path-client");

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
  expect(instance).toBeInstanceOf(Elysia);
  expect(getProductionTemplate()).toContain("fallback-client");

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
  expect(instance).toBeInstanceOf(Elysia);
  expect(getSSGCache("/")?.html).toBe("<html>prebuilt</html>");

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
  expect(revalidateTag("boards")).toBe(true);
  expect(ssgCache.has("/")).toBe(false);

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
  expect(instance).toBeInstanceOf(Elysia);
  expect(getProductionTemplate()).toContain("cwd-client");

  resetState();
  app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  await setCompileContext(app.path, { assets: {}, template: "" });
  await expect(furin({ pagesDir: join(app.path, "src/pages") })).rejects.toThrow(
    "HTML template"
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

  expect(okClient.status).toBe(200);
  expect(okPublic.status).toBe(200);
  expect(missClient.status).toBe(404);
  expect(missPublic.status).toBe(404);
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
