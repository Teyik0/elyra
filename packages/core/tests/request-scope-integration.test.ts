/**
 * Integration test: verifies that per-request AsyncLocalStorage scope is
 * established when furin is mounted as a sub-plugin inside a parent Elysia
 * instance. Without this, global pending invalidations leak into every request.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { furin, revalidatePath } from "furin";
import { __resetCacheState } from "../src/server/cache/index.ts";
import { __resetCompileContext } from "../src/server/internal.ts";
import {
  setProductionTemplateContent,
  setProductionTemplatePath,
} from "../src/server/render/template.ts";
import { __setDevMode } from "../src/server/runtime-env.ts";
import { createTmpApp, writeAppFile } from "./helpers/tmp-app.ts";

const tmpApps: Array<{ cleanup: () => void }> = [];
const originalCwd = process.cwd();

afterEach(() => {
  __setDevMode(true);
  setProductionTemplatePath(null);
  __resetCompileContext();
  process.chdir(originalCwd);
  __resetCacheState();
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

describe.serial("request scope isolation when furin is mounted as a plugin", () => {
  test("global pending invalidations do not leak into plugin request scope", async () => {
    const app = createTmpApp("cli-app");
    tmpApps.push(app);
    __setDevMode(true);
    process.chdir(app.path);

    writeAppFile(
      app.path,
      "src/pages/revalidate-a.tsx",
      [
        'import { route as rootRoute } from "./root";',
        'import { revalidatePath } from "@teyik0/furin";',
        "",
        "export default rootRoute.page({",
        "  loader: () => {",
        '    revalidatePath("/page-a", "page");',
        "    return {};",
        "  },",
        "  component: () => <div>Page A</div>,",
        "});",
      ].join("\n")
    );

    writeAppFile(
      app.path,
      "src/pages/revalidate-b.tsx",
      [
        'import { route as rootRoute } from "./root";',
        'import { revalidatePath } from "@teyik0/furin";',
        "",
        "export default rootRoute.page({",
        "  loader: () => {",
        '    revalidatePath("/page-b", "page");',
        "    return {};",
        "  },",
        "  component: () => <div>Page B</div>,",
        "});",
      ].join("\n")
    );

    setProductionTemplateContent("<html><body><!--ssr-outlet--></body></html>");

    const plugin = await furin({ pagesDir: join(app.path, "src/pages") });
    const parent = new Elysia().use(plugin);

    // Global invalidation (outside any request scope).
    // If the plugin request scope is broken, this path leaks into the response.
    revalidatePath("/global-leak", "page");

    const response = await parent.handle(new Request("http://furin/revalidate-a"));
    const header = response.headers.get("x-furin-revalidate");

    // With proper per-request scoping, only /page-a should be present.
    // If handle mutation is used (and lost by plugin merge), the global Set
    // is shared and header would be "/global-leak,/page-a".
    expect(header).toBe("/page-a");
  });

  test("concurrent requests do not steal each other's pending invalidations", async () => {
    const app = createTmpApp("cli-app");
    tmpApps.push(app);
    __setDevMode(true);
    process.chdir(app.path);

    writeAppFile(
      app.path,
      "src/pages/revalidate-a.tsx",
      [
        'import { route as rootRoute } from "./root";',
        'import { revalidatePath } from "@teyik0/furin";',
        "",
        "export default rootRoute.page({",
        "  loader: async () => {",
        '    revalidatePath("/page-a", "page");',
        "    return {};",
        "  },",
        "  component: () => <div>Page A</div>,",
        "});",
      ].join("\n")
    );

    writeAppFile(
      app.path,
      "src/pages/revalidate-b.tsx",
      [
        'import { route as rootRoute } from "./root";',
        'import { revalidatePath } from "@teyik0/furin";',
        "",
        "export default rootRoute.page({",
        "  loader: async () => {",
        '    revalidatePath("/page-b", "page");',
        "    return {};",
        "  },",
        "  component: () => <div>Page B</div>,",
        "});",
      ].join("\n")
    );

    setProductionTemplateContent("<html><body><!--ssr-outlet--></body></html>");

    const plugin = await furin({ pagesDir: join(app.path, "src/pages") });
    const parent = new Elysia().use(plugin);

    const [resA, resB] = await Promise.all([
      parent.handle(new Request("http://furin/revalidate-a")),
      parent.handle(new Request("http://furin/revalidate-b")),
    ]);

    const headerA = resA.headers.get("x-furin-revalidate");
    const headerB = resB.headers.get("x-furin-revalidate");

    // Each request should only see its own invalidation path.
    expect(headerA).toBe("/page-a");
    expect(headerB).toBe("/page-b");
  });
});
