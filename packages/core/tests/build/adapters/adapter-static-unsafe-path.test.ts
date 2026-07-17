import "../../setup/global.ts";

import { expect, test } from "bun:test";
import { join } from "node:path";
import { __resetCacheState } from "../../../src/server/cache/index.ts";
import { __resetTemplateState } from "../../../src/server/render/template.ts";
import { scanPages } from "../../../src/server/router/index.ts";
import { __setDevMode } from "../../../src/server/runtime-env.ts";
import { createTmpApp } from "../../support/app-fixtures.ts";
import { withBuildStub } from "../../support/with-build-stub.ts";

const { buildStaticTarget } = await import("../../../src/adapter/static.ts");
const UNSAFE_PATH_RE = /unsafe output path/;

test("buildStaticTarget rejects unsafe output paths", async () => {
  __setDevMode(false);
  __resetCacheState();
  __resetTemplateState();

  const app = createTmpApp("cli-app");
  try {
    const scanned = await scanPages(join(app.path, "src/pages"));
    const dynamicRoute = scanned.routes.find((route) => route.pattern.includes(":"));
    expect(dynamicRoute).toBeDefined();
    if (dynamicRoute === undefined) {
      return;
    }
    const unsafeRoute = {
      ...dynamicRoute,
      page: {
        ...dynamicRoute.page,
        staticParams: async () => [{ slug: "../../etc/passwd" }],
      },
    };
    await expect(
      withBuildStub(() =>
        buildStaticTarget([unsafeRoute], app.path, join(app.path, ".furin/build"), scanned.root, {
          staticConfig: { outDir: join(app.path, "dist") },
          target: "static",
        }),
      ),
    ).rejects.toThrow(UNSAFE_PATH_RE);
  } finally {
    app.cleanup();
  }
});
