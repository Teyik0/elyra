import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildBunTarget } from "../src/adapter/bun.ts";
import type { BuildAppOptions } from "../src/build/types.ts";
import { scanPages } from "../src/server/router/index.ts";
import { createTmpApp } from "./helpers/tmp-app.ts";
import { withBuildStub } from "./helpers/with-build-stub.ts";

const tmpApps: Array<{ cleanup: () => void }> = [];
const originalBunBuild = Bun.build;

function rememberTmpApp<T extends { cleanup: () => void }>(app: T): T {
  tmpApps.push(app);
  return app;
}

afterEach(() => {
  Bun.build = originalBunBuild;
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

describe.serial("buildBunTarget compile branches", () => {
  test("throws when compile is enabled without a server entry", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    const options: BuildAppOptions = { target: "bun", compile: "server" };

    await expect(
      buildBunTarget(
        [
          {
            pagesDir: join(app.path, "src/pages"),
            prefix: "",
            root: { path: join(app.path, "src/pages/root.tsx"), route: {} as never },
            routes: [],
          },
        ],
        app.path,
        join(app.path, ".furin/build"),
        null,
        options
      )
    ).rejects.toThrow("server entry");
  });

  test("compile server keeps client assets on disk", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    const { root, routes } = await scanPages(join(app.path, "src/pages"));

    await withBuildStub(async () => {
      await buildBunTarget(
        [{ pagesDir: join(app.path, "src/pages"), prefix: "", root, routes }],
        app.path,
        join(app.path, ".furin/build"),
        join(app.path, "src/server.ts"),
        { target: "bun", compile: "server" }
      );
    });

    const targetDir = join(app.path, ".furin/build/bun");
    expect(existsSync(join(targetDir, "client"))).toBe(true);
    expect(existsSync(join(targetDir, "public/.gitkeep"))).toBe(true);
  });

  test("compile embed removes client assets after build", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    const { root, routes } = await scanPages(join(app.path, "src/pages"));

    await withBuildStub(async () => {
      await buildBunTarget(
        [{ pagesDir: join(app.path, "src/pages"), prefix: "", root, routes }],
        app.path,
        join(app.path, ".furin/build"),
        join(app.path, "src/server.ts"),
        { target: "bun", compile: "embed" }
      );
    });

    const targetDir = join(app.path, ".furin/build/bun");
    expect(existsSync(join(targetDir, "client"))).toBe(false);
  });

  test("client-only Bun build does not run SSG staticParams snapshot", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    writeFileSync(
      join(app.path, "src/pages/index.tsx"),
      [
        'import { createRoute } from "@teyik0/furin/client";',
        'const route = createRoute({ mode: "ssg" });',
        "export default route.page({",
        "  component: () => <main>Home</main>,",
        '  staticParams: async () => { throw new Error("snapshot should not run"); },',
        "});",
      ].join("\n")
    );
    const { root, routes } = await scanPages(join(app.path, "src/pages"));

    await withBuildStub(async () => {
      await expect(
        buildBunTarget(
          [{ pagesDir: join(app.path, "src/pages"), prefix: "", root, routes }],
          app.path,
          join(app.path, ".furin/build"),
          null,
          { target: "bun" }
        )
      ).resolves.toBeDefined();
    });
  });
});
