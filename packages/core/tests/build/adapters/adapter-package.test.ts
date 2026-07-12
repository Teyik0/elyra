import { describe, expect, test } from "bun:test";
import { join as joinPath } from "node:path";

const PACKAGE_TARGET_SCENARIOS = String.raw`
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPackageTarget } from "./src/adapter/package.ts";
import { __resetCacheState } from "./src/server/cache/index.ts";
import { __resetTemplateState } from "./src/server/render/template.ts";
import { scanPages } from "./src/server/router/index.ts";
import { createTmpApp, removeAppPath, writeAppFile } from "./tests/support/app-fixtures.ts";
import { withBuildStub } from "./tests/support/with-build-stub.ts";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function buildPackage(appPath, prefix) {
  __resetTemplateState();
  __resetCacheState();
  const { root, routes } = await scanPages(join(appPath, "src/pages"));
  return await withBuildStub(() =>
    buildPackageTarget(
      { pagesDir: join(appPath, "src/pages"), prefix, root, routes },
      appPath,
      join(appPath, ".furin/build"),
      { target: "package" }
    )
  );
}

{
  const app = createTmpApp("cli-app");
  await buildPackage(app.path, "/shop");
  assert(
    existsSync(join(app.path, ".furin/build/package/public/.gitkeep")),
    "package build should copy public/.gitkeep"
  );
}

{
  const app = createTmpApp("cli-app");
  removeAppPath(app.path, "public");
  const manifest = await buildPackage(app.path, "/shop");
  assert(manifest.buildId, "package build without public/ should emit a buildId");
  assert(
    !existsSync(join(app.path, ".furin/build/package/public")),
    "package build without public/ should not create public/"
  );
}

{
  const app = createTmpApp("cli-app");
  await buildPackage(app.path, "/shop");
  const factory = readFileSync(join(app.path, ".furin/build/package/index.js"), "utf8");
  const spreadIndex = factory.indexOf("...options");
  const pagesDirIndex = factory.indexOf("pagesDir: PAGES_DIR");
  const prefixIndex = factory.indexOf('prefix: "/shop"');
  const clientDirIndex = factory.indexOf("clientDir: CLIENT_DIR");
  assert(spreadIndex > -1, "factory should spread caller options");
  assert(pagesDirIndex > spreadIndex, "baked pagesDir should override caller options");
  assert(prefixIndex > spreadIndex, "baked prefix should override caller options");
  assert(clientDirIndex > spreadIndex, "baked clientDir should override caller options");
  assert(factory.includes('export const prefix = "/shop"'), "factory should export prefix");
}

{
  const app = createTmpApp("cli-app");
  await buildPackage(app.path, "/shop");
  const dts = readFileSync(join(app.path, ".furin/build/package/index.d.ts"), "utf8");
  assert(
    dts.includes('import type { FurinOptions } from "@teyik0/furin"'),
    "index.d.ts should import FurinOptions"
  );
  assert(
    dts.includes('export type CreateFurinAppOptions = Omit<FurinOptions, "pagesDir" | "prefix" | "clientDir">'),
    "index.d.ts should omit baked options"
  );
  assert(
    dts.includes("createFurinApp(options?: CreateFurinAppOptions): Promise<Elysia>"),
    "index.d.ts should type createFurinApp"
  );
}

{
  const app = createTmpApp("cli-app");
  const first = await buildPackage(app.path, "/shop");
  const pagePath = join(app.path, "src/pages/index.tsx");
  writeAppFile(
    app.path,
    "src/pages/index.tsx",
    readFileSync(pagePath, "utf8") + "\n// ssr-only change\n"
  );
  const second = await buildPackage(app.path, "/shop");
  assert(first.buildId, "first package build should emit a buildId");
  assert(second.buildId, "second package build should emit a buildId");
  assert(second.buildId !== first.buildId, "SSR-only source changes should change buildId");
}

process.exit(0);
`;

describe("buildPackageTarget", () => {
  test("handles public assets, factory output, types, and SSR-only build IDs", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", PACKAGE_TARGET_SCENARIOS],
      cwd: joinPath(import.meta.dir, "../../.."),
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
