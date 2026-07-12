/**
 * Multi-instance composition — two `furin()` apps mounted into one parent
 * Elysia under different prefixes. Covers route prefixing, per-instance state
 * isolation (revalidation headers, sync stream injection), the prefix
 * collision guard, per-instance 404s, and the data endpoint under a prefix.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { furin } from "furin";
import { __resetCacheState } from "../src/server/cache/index.ts";
import { __resetCompileContext } from "../src/server/internal.ts";
import {
  __resetTemplateState,
  setProductionTemplateContent,
} from "../src/server/render/template.ts";
import { __setDevMode } from "../src/server/runtime-env.ts";
import { __resetSyncState } from "../src/server/sync/index.ts";
import { createTmpApp, writeAppFile } from "./helpers/tmp-app.ts";

const TEST_TEMPLATE = "<html><body><!--ssr-outlet--></body></html>";

/** Prefixed self-link rendered with SSR active state (logical currentHref). */
const ACTIVE_ADMIN_NAV_LINK_RE = /href="\/admin\/nav"[^>]*data-status="active"/;

const tmpApps: Array<{ cleanup: () => void }> = [];
const originalCwd = process.cwd();

afterEach(() => {
  __setDevMode(true);
  __resetTemplateState();
  __resetCompileContext();
  __resetSyncState();
  process.chdir(originalCwd);
  __resetCacheState();
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

/** Writes a second, self-contained pages tree under src/admin. */
function writeAdminPages(appPath: string): string {
  writeAppFile(
    appPath,
    "src/admin/root.tsx",
    [
      'import { createRoute } from "@teyik0/furin/client";',
      "",
      "export const route = createRoute({",
      '  layout: ({ children }) => <div data-testid="admin-layout">{children}</div>,',
      "});",
    ].join("\n")
  );
  writeAppFile(
    appPath,
    "src/admin/index.tsx",
    [
      'import { route as rootRoute } from "./root";',
      "",
      "export default rootRoute.page({",
      "  component: () => <main>Admin home</main>,",
      "});",
    ].join("\n")
  );
  writeAppFile(
    appPath,
    "src/admin/nav.tsx",
    [
      'import { Link } from "@teyik0/furin/link";',
      'import { route as rootRoute } from "./root";',
      "",
      "export default rootRoute.page({",
      // SSR mode: the render sees the real (PHYSICAL, prefix-included) Elysia
      // ctx.path instead of a synthetic logical one — exercises the basePath
      // strip in currentHrefFromContext, not just the href prefixing.
      '  mode: "ssr",',
      "  component: () => (",
      "    <nav>",
      '      <Link to="/users">Users link</Link>',
      '      <Link to="/nav">Self link</Link>',
      "    </nav>",
      "  ),",
      "});",
    ].join("\n")
  );
  writeAppFile(
    appPath,
    "src/admin/users.tsx",
    [
      'import { route as rootRoute } from "./root";',
      'import { revalidatePath } from "@teyik0/furin";',
      "",
      "export default rootRoute.page({",
      "  loader: () => {",
      '    revalidatePath("/from-admin", "page");',
      '    return { who: "admin" };',
      "  },",
      "  component: () => <main>Admin users</main>,",
      "});",
    ].join("\n")
  );
  return join(appPath, "src/admin");
}

async function mountBothApps(options?: { adminSync?: boolean }) {
  const app = createTmpApp("cli-app");
  tmpApps.push(app);
  __setDevMode(true);
  process.chdir(app.path);

  writeAppFile(
    app.path,
    "src/pages/revalidating.tsx",
    [
      'import { route as rootRoute } from "./root";',
      'import { revalidatePath } from "@teyik0/furin";',
      "",
      "export default rootRoute.page({",
      "  loader: () => {",
      '    revalidatePath("/from-front", "page");',
      "    return {};",
      "  },",
      "  component: () => <main>Front revalidating</main>,",
      "});",
    ].join("\n")
  );
  writeAppFile(
    app.path,
    "src/pages/nav.tsx",
    [
      'import { Link } from "@teyik0/furin/link";',
      'import { route as rootRoute } from "./root";',
      "",
      "export default rootRoute.page({",
      "  component: () => (",
      "    <nav>",
      '      <Link to="/users">Users link</Link>',
      "    </nav>",
      "  ),",
      "});",
    ].join("\n")
  );
  const adminPagesDir = writeAdminPages(app.path);

  setProductionTemplateContent(TEST_TEMPLATE);

  const front = await furin({ pagesDir: join(app.path, "src/pages") });
  const admin = await furin({
    pagesDir: adminPagesDir,
    prefix: "/admin",
    sync: options?.adminSync ?? false,
  });
  const parent = new Elysia().use(front).use(admin);
  return { app, parent };
}

describe.serial("multi-instance furin composition", () => {
  test("routes are served under each instance's prefix", async () => {
    const { parent } = await mountBothApps();

    const frontHome = await parent.handle(new Request("http://furin/"));
    expect(frontHome.status).toBe(200);
    expect(await frontHome.text()).toContain("Home page");

    const adminHome = await parent.handle(new Request("http://furin/admin"));
    expect(adminHome.status).toBe(200);
    const adminHomeHtml = await adminHome.text();
    expect(adminHomeHtml).toContain("Admin home");
    expect(adminHomeHtml).toContain("admin-layout");

    const adminUsers = await parent.handle(new Request("http://furin/admin/users"));
    expect(adminUsers.status).toBe(200);
    expect(await adminUsers.text()).toContain("Admin users");

    // Admin pages must NOT exist at the root scope.
    const rootUsers = await parent.handle(new Request("http://furin/users"));
    expect(rootUsers.status).toBe(404);
  });

  test("mounting two different apps on the same prefix throws", async () => {
    const app = createTmpApp("cli-app");
    tmpApps.push(app);
    __setDevMode(true);
    process.chdir(app.path);
    const adminPagesDir = writeAdminPages(app.path);
    setProductionTemplateContent(TEST_TEMPLATE);

    await furin({ pagesDir: join(app.path, "src/pages") });
    await expect(furin({ pagesDir: adminPagesDir })).rejects.toThrow("already mounted");
  });

  test("concurrent requests to different instances keep their own revalidation headers", async () => {
    const { parent } = await mountBothApps();

    const [frontRes, adminRes] = await Promise.all([
      parent.handle(new Request("http://furin/revalidating")),
      parent.handle(new Request("http://furin/admin/users")),
    ]);

    expect(frontRes.headers.get("x-furin-revalidate")).toBe("/from-front");
    expect(adminRes.headers.get("x-furin-revalidate")).toBe("/from-admin");
  });

  test("sync stream script is injected only for the sync-enabled instance", async () => {
    const { parent } = await mountBothApps({ adminSync: true });

    const adminHtml = await (await parent.handle(new Request("http://furin/admin"))).text();
    expect(adminHtml).toContain("__FURIN_SYNC__");
    // Logical (unprefixed) path — the client prepends its own basePath.
    expect(adminHtml).toContain("/_furin/sync");

    const frontHtml = await (await parent.handle(new Request("http://furin/"))).text();
    expect(frontHtml).not.toContain("__FURIN_SYNC__");
  });

  test("the sync SSE endpoint is mounted under the instance prefix", async () => {
    const { parent } = await mountBothApps({ adminSync: true });

    const prefixed = await parent.handle(new Request("http://furin/admin/_furin/sync/changes"));
    expect(prefixed.status).toBe(200);

    // No root-level sync — the front instance did not enable it.
    const unprefixed = await parent.handle(new Request("http://furin/_furin/sync/changes"));
    expect(unprefixed.status).toBe(404);
  });

  test("the data endpoint answers under the instance prefix with logical paths", async () => {
    const { parent } = await mountBothApps();

    const res = await parent.handle(new Request("http://furin/admin/_furin/data?path=%2Fusers"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(await res.text()).toContain("admin");
  });

  test("SSR link hrefs are physical (prefixed) and active state stays logical", async () => {
    const { parent } = await mountBothApps();

    // Prefixed instance: <Link to="/users"> must render the PHYSICAL href
    // (basePath + logical) so the anchor works before hydration, and the
    // self-link must be active — currentHref is LOGICAL (prefix stripped),
    // matching the prefix-aware client hydration.
    const adminNav = await parent.handle(new Request("http://furin/admin/nav"));
    expect(adminNav.status).toBe(200);
    const adminHtml = await adminNav.text();
    expect(adminHtml).toContain('href="/admin/users"');
    expect(adminHtml).not.toContain('href="/users"');
    expect(adminHtml).toMatch(ACTIVE_ADMIN_NAV_LINK_RE);

    // Root instance: links stay unprefixed.
    const frontNav = await parent.handle(new Request("http://furin/nav"));
    expect(frontNav.status).toBe(200);
    expect(await frontNav.text()).toContain('href="/users"');
  });

  test("each instance serves its own 404", async () => {
    const { parent } = await mountBothApps();

    // Prefixed instance: catch-all route renders its 404 shell.
    const adminMiss = await parent.handle(new Request("http://furin/admin/does-not-exist"));
    expect(adminMiss.status).toBe(404);
    expect(await adminMiss.text()).toContain("404");

    // Root instance: historical global NOT_FOUND handler.
    const frontMiss = await parent.handle(new Request("http://furin/does-not-exist"));
    expect(frontMiss.status).toBe(404);
  });
});
