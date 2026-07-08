import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildBunTarget } from "../src/adapter/bun.ts";
import { __resetTemplateState } from "../src/server/render/template.ts";
import { scanPages } from "../src/server/router/discovery.ts";
import { createTmpApp } from "./helpers/tmp-app.ts";
import { withBuildStub } from "./helpers/with-build-stub.ts";

const tmpApps: Array<{ cleanup: () => void }> = [];

function rememberTmpApp<T extends { cleanup: () => void }>(app: T): T {
  tmpApps.push(app);
  return app;
}

afterEach(async () => {
  __resetTemplateState();
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
  await Promise.resolve();
});

describe("buildBunTarget client-only branch", () => {
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
        buildBunTarget(routes, app.path, join(app.path, ".furin/build"), root, null, {
          target: "bun",
        })
      ).resolves.toBeDefined();
    });
  });
});
