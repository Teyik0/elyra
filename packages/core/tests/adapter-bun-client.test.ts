import { describe, expect, test } from "bun:test";
import { join as joinPath } from "node:path";

const BUILD_BUN_TARGET_SCENARIOS = String.raw`
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildBunTarget } from "./src/adapter/bun.ts";
import { __resetTemplateState } from "./src/server/render/template.ts";
import { scanPages } from "./src/server/router/discovery.ts";
import { createTmpApp } from "./tests/helpers/tmp-app.ts";
import { withBuildStub } from "./tests/helpers/with-build-stub.ts";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createCompileTmpApp() {
  const app = createTmpApp("cli-app");
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

for (const compile of ["server", "embed"]) {
  __resetTemplateState();
  const app = createCompileTmpApp();
  const { root, routes } = await scanPages(join(app.path, "src/pages"));
  await withBuildStub(async () => {
    await buildBunTarget(
      routes,
      app.path,
      join(app.path, ".furin/build"),
      root,
      join(app.path, "src/server.ts"),
      { compile, target: "bun" }
    );
  });
  const clientDir = join(app.path, ".furin/build/bun/client");
  assert(
    existsSync(clientDir) === (compile === "server"),
    compile === "server"
      ? "compile server should keep client assets on disk"
      : "compile embed should remove client assets"
  );
  if (compile === "server") {
    assert(
      existsSync(join(app.path, ".furin/build/bun/public/.gitkeep")),
      "compile server should keep copied public assets"
    );
  }
}

__resetTemplateState();
const app = createTmpApp("cli-app");
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
  const manifest = await buildBunTarget(
    routes,
    app.path,
    join(app.path, ".furin/build"),
    root,
    null,
    { target: "bun" }
  );
  assert(manifest.rscManifestPath === undefined, "client-only build should not emit RSC manifest");
});

process.exit(0);
`;

describe("buildBunTarget Bun branches", () => {
  test("handles server, embed, and client-only targets", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", BUILD_BUN_TARGET_SCENARIOS],
      cwd: joinPath(import.meta.dir, ".."),
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
