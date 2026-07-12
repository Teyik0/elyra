import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPackageTarget } from "../src/adapter/package.ts";
import type { PackageTargetBuildManifest } from "../src/build/types.ts";
import { __resetCacheState } from "../src/server/cache/index.ts";
import { __resetTemplateState } from "../src/server/render/template.ts";
import { scanPages } from "../src/server/router/index.ts";
import { createTmpApp, removeAppPath, writeAppFile } from "./helpers/tmp-app.ts";
import { withBuildStub } from "./helpers/with-build-stub.ts";

const tmpApps: Array<{ cleanup: () => void }> = [];
const originalBunBuild = Bun.build;

function rememberTmpApp<T extends { cleanup: () => void }>(app: T): T {
  tmpApps.push(app);
  return app;
}

afterEach(() => {
  Bun.build = originalBunBuild;
  __resetTemplateState();
  __resetCacheState();
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

/** Runs `buildPackageTarget` against a tmp app with the bundler stubbed out. */
async function buildPackage(appPath: string, prefix: string): Promise<PackageTargetBuildManifest> {
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

describe.serial("buildPackageTarget", () => {
  test("copies the project public/ dir into the artifact", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    await buildPackage(app.path, "/shop");

    // At runtime furin() derives publicDir next to the baked clientDir, so
    // the assets must live at <targetDir>/public inside the artifact.
    expect(existsSync(join(app.path, ".furin/build/package/public/.gitkeep"))).toBe(true);
  });

  test("builds without a public/ dir in the project", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    removeAppPath(app.path, "public");

    const manifest = await buildPackage(app.path, "/shop");

    expect(manifest.buildId).toBeDefined();
    expect(existsSync(join(app.path, ".furin/build/package/public"))).toBe(false);
  });

  test("factory spreads caller options BEFORE the baked pagesDir/prefix/clientDir", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    await buildPackage(app.path, "/shop");

    const factory = readFileSync(join(app.path, ".furin/build/package/index.js"), "utf8");
    const spreadIndex = factory.indexOf("...options");
    const pagesDirIndex = factory.indexOf("pagesDir: PAGES_DIR");
    const prefixIndex = factory.indexOf('prefix: "/shop"');
    const clientDirIndex = factory.indexOf("clientDir: CLIENT_DIR");

    // Baked values must win over caller options — the spread comes first.
    expect(spreadIndex).toBeGreaterThan(-1);
    expect(pagesDirIndex).toBeGreaterThan(spreadIndex);
    expect(prefixIndex).toBeGreaterThan(spreadIndex);
    expect(clientDirIndex).toBeGreaterThan(spreadIndex);
    expect(factory).toContain('export const prefix = "/shop"');
  });

  test("index.d.ts types the factory options off the real FurinOptions", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    await buildPackage(app.path, "/shop");

    const dts = readFileSync(join(app.path, ".furin/build/package/index.d.ts"), "utf8");

    expect(dts).toContain('import type { FurinOptions } from "@teyik0/furin"');
    expect(dts).toContain(
      'export type CreateFurinAppOptions = Omit<FurinOptions, "pagesDir" | "prefix" | "clientDir">'
    );
    expect(dts).toContain("createFurinApp(options?: CreateFurinAppOptions): Promise<Elysia>");
  });

  test("buildId changes on an SSR-only source change with identical client output", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const first = await buildPackage(app.path, "/shop");

    // withBuildStub returns the same synthetic client chunks on every run, so
    // only the fingerprint's route-source contents can move the build ID —
    // exactly the stale-deploy case the weak chunk-only hash used to miss.
    const pagePath = join(app.path, "src/pages/index.tsx");
    writeAppFile(
      app.path,
      "src/pages/index.tsx",
      `${readFileSync(pagePath, "utf8")}\n// ssr-only change\n`
    );

    const second = await buildPackage(app.path, "/shop");

    expect(first.buildId).toBeDefined();
    expect(second.buildId).toBeDefined();
    expect(second.buildId).not.toBe(first.buildId);
  });
});
