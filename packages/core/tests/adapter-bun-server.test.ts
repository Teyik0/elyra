import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildBunTarget } from "../src/adapter/bun.ts";
import { __resetTemplateState } from "../src/server/render/template.ts";
import { scanPages } from "../src/server/router/discovery.ts";
import { createTmpApp } from "./helpers/tmp-app.ts";
import { withBuildStub } from "./helpers/with-build-stub.ts";

const tmpApps: Array<{ cleanup: () => void }> = [];

function createCompileTmpApp() {
  const app = createTmpApp("cli-app");
  tmpApps.push(app);
  writeFileSync(
    join(app.path, "src/pages/blog/[slug].tsx"),
    [
      'import { route as rootRoute } from "../root";',
      "",
      "export default rootRoute.page({",
      "  component: () => <article>Blog post page</article>,",
      "});",
    ].join("\n")
  );
  return app;
}

afterEach(async () => {
  __resetTemplateState();
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
  await Promise.resolve();
});

describe("buildBunTarget server compile branch", () => {
  test("compile server keeps client assets on disk", async () => {
    const app = createCompileTmpApp();
    const { root, routes } = await scanPages(join(app.path, "src/pages"));

    await withBuildStub(async () => {
      await buildBunTarget(
        routes,
        app.path,
        join(app.path, ".furin/build"),
        root,
        join(app.path, "src/server.ts"),
        { compile: "server", target: "bun" }
      );
    });

    const targetDir = join(app.path, ".furin/build/bun");
    expect(existsSync(join(targetDir, "client"))).toBe(true);
    expect(existsSync(join(targetDir, "public/.gitkeep"))).toBe(true);
  });
});
