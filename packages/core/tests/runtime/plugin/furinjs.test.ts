import { expect, test } from "bun:test";

const TESTS_DIR_SUFFIX_RE = /\/tests(?:\/.*)?$/;

test("furin() integration scenarios", () => {
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `
import { expect } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Elysia from "elysia";
import { furin } from "./src/furin.ts";
import { __resetCompileContext, __setCompileContext } from "./src/server/internal.ts";
import { setProductionTemplatePath } from "./src/server/render/template.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
import { runCli } from "./tests/support/process.ts";
import { createTmpApp, removeAppPath, writeAppFile } from "./tests/support/app-fixtures.ts";

const tmpApps = [];
const originalCwd = process.cwd();
const originalArgv = process.argv.slice();

function rememberTmpApp(app) {
  tmpApps.push(app);
  return app;
}

function resetState() {
  __setDevMode(true);
  setProductionTemplatePath(null);
  __resetCompileContext();
  process.chdir(originalCwd);
  process.argv.length = 0;
  process.argv.push(...originalArgv);
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
}

try {
  resetState();
  let app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(true);
  process.chdir(app.path);

  let instance = await furin({
    pagesDir: join(app.path, "src/pages"),
  });

  expect(instance).toBeInstanceOf(Elysia);
  expect(existsSync(join(app.path, ".furin/index.html"))).toBe(true);
  expect(existsSync(join(app.path, ".furin/_hydrate.tsx"))).toBe(true);
  expect(existsSync(join(app.path, "furin-env.d.ts"))).toBe(true);

  resetState();
  app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  await expect(furin({ pagesDir: join(app.path, "src/pages") })).rejects.toThrow("furin build");

  resetState();
  app = rememberTmpApp(createTmpApp("cli-app"));
  const result = await runCli(["build", "--target", "bun"], { cwd: app.path });
  expect(result.exitCode).toBe(0);

  __setDevMode(false);
  process.chdir(app.path);
  process.argv[1] = join(app.path, ".furin/build/bun/server.js");

  let rootPath = join(app.path, "src/pages/root.tsx");
  let indexPath = join(app.path, "src/pages/index.tsx");
  let blogSlugPath = join(app.path, "src/pages/blog/[slug].tsx");

  let [rootMod, indexMod, blogSlugMod] = await Promise.all([
    import(rootPath),
    import(indexPath),
    import(blogSlugPath),
  ]);

  __setCompileContext({
    modules: {
      [rootPath]: rootMod,
      [indexPath]: indexMod,
      [blogSlugPath]: blogSlugMod,
    },
    rootConventions: {},
    rootPath,
    routeMetadata: {
      [indexPath]: { segmentBoundaries: [] },
      [blogSlugPath]: { segmentBoundaries: [] },
    },
    routes: [
      { mode: "ssg", path: indexPath, pattern: "/" },
      { mode: "ssg", path: blogSlugPath, pattern: "/blog/:slug" },
    ],
  });

  let plugin = await furin({
    pagesDir: join(app.path, "src/pages"),
  });
  let server = new Elysia().use(plugin).listen(0);

  try {
    await Bun.sleep(50);
    expect(server.server).toBeDefined();
  } finally {
    server.stop();
  }

  resetState();
  app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  const templatePath = join(app.path, "fake-template.html");
  writeFileSync(templatePath, "<html><head></head><body><!--ssr-outlet--></body></html>");
  const clientAssetPath = join(app.path, "client.js");
  const publicAssetPath = join(app.path, "logo.png");
  writeFileSync(clientAssetPath, "console.log('client');");
  writeFileSync(publicAssetPath, "logo");

  rootPath = join(app.path, "src/pages/root.tsx");
  indexPath = join(app.path, "src/pages/index.tsx");
  blogSlugPath = join(app.path, "src/pages/blog/[slug].tsx");

  [rootMod, indexMod, blogSlugMod] = await Promise.all([
    import(rootPath),
    import(indexPath),
    import(blogSlugPath),
  ]);

  __setCompileContext({
    embedded: {
      assets: {
        "/_client/app.js": clientAssetPath,
        "/public/logo.png": publicAssetPath,
      },
      template: templatePath,
    },
    modules: {
      [rootPath]: rootMod,
      [indexPath]: indexMod,
      [blogSlugPath]: blogSlugMod,
    },
    rootConventions: {},
    rootPath,
    routeMetadata: {
      [indexPath]: { segmentBoundaries: [] },
      [blogSlugPath]: { segmentBoundaries: [] },
    },
    routes: [
      { mode: "ssg", path: indexPath, pattern: "/" },
      { mode: "ssg", path: blogSlugPath, pattern: "/blog/:slug" },
    ],
  });

  instance = await furin({ pagesDir: join(app.path, "src/pages") });
  expect(instance).toBeInstanceOf(Elysia);
  const okClient = await instance.handle(new Request("http://furin/_client/app.js"));
  const okPublic = await instance.handle(new Request("http://furin/public/logo.png"));
  const missClient = await instance.handle(new Request("http://furin/_client/missing.js"));
  const missPublic = await instance.handle(new Request("http://furin/public/missing.png"));

  expect(okClient.status).toBe(200);
  expect(okPublic.status).toBe(200);
  expect(missClient.status).toBe(404);
  expect(missPublic.status).toBe(404);

  resetState();
  app = rememberTmpApp(createTmpApp("cli-app"));
  removeAppPath(app.path, "src/pages/root.tsx");
  writeAppFile(
    app.path,
    "src/pages/index.tsx",
    [
      'import { createRoute } from "furin/client";',
      "const route = createRoute({ mode: 'ssg' });",
      "export default route.page({ component: () => <main>No root</main> });",
    ].join("\\n")
  );
  writeAppFile(
    app.path,
    "src/pages/blog/[slug].tsx",
    [
      'import { createRoute } from "furin/client";',
      "const route = createRoute({ mode: 'ssg' });",
      "export default route.page({",
      "  staticParams: () => [{ slug: 'hello-world' }],",
      "  component: () => <article>No root blog</article>,",
      "});",
    ].join("\\n")
  );
  __setDevMode(true);
  process.chdir(app.path);

  await expect(
    furin({
      pagesDir: join(app.path, "src/pages"),
    })
  ).rejects.toThrow();
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
        `furin integration subprocess exited with ${proc.exitCode}`,
        new TextDecoder().decode(proc.stdout),
        new TextDecoder().decode(proc.stderr),
      ].join("\n")
    );
  }

  expect(proc.exitCode).toBe(0);
});
