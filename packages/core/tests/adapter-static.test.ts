/**
 * Tests for the static export adapter.
 *
 * All tests are inside a single describe.serial block because buildStaticTarget
 * calls setProductionTemplateContent() — a module-level singleton that is not
 * safe to mutate from concurrent describe blocks.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildStaticTarget } from "../src/adapter/static.ts";
import type { BuildAppOptions } from "../src/build/types.ts";
import { __resetCacheState } from "../src/render/cache.ts";
import { __resetTemplateState } from "../src/render/template.ts";
import { scanPages } from "../src/router.ts";
import { __setDevMode, IS_DEV } from "../src/runtime-env.ts";
import { createTmpApp } from "./helpers/tmp-app.ts";
import { withBuildStub } from "./helpers/with-build-stub.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const SSR_STATIC_RE = /SSR.*static/i;
const BASEPATH_RE = /basePath must start with/;
const UNSAFE_DIR_RE = /unsafe to delete/;
const PRERENDER_FAIL_RE = /route\(s\) failed to pre-render/;
const UNSAFE_PATH_RE = /unsafe output path/;

// ── Helpers ───────────────────────────────────────────────────────────────────

const tmpApps: Array<{ cleanup: () => void }> = [];

let originalIsDev: boolean;
beforeAll(() => {
  originalIsDev = IS_DEV;
  __setDevMode(false);
});
afterAll(() => __setDevMode(originalIsDev));

afterEach(() => {
  __resetCacheState();
  __resetTemplateState();
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

function makeApp(fixtureName = "cli-app") {
  const app = createTmpApp(fixtureName);
  tmpApps.push(app);
  return app;
}

async function runStaticBuild(fixtureName = "cli-app", extra?: Partial<BuildAppOptions>) {
  const app = makeApp(fixtureName);
  const { root, routes } = await scanPages(join(app.path, "src/pages"));
  const distDir = join(app.path, "dist");

  await withBuildStub(() =>
    buildStaticTarget(routes, app.path, join(app.path, ".furin/build"), root, {
      target: "static",
      staticConfig: { outDir: distDir },
      ...extra,
    })
  );
  return { app, distDir };
}

// ── All tests run serially to avoid singleton state races ─────────────────────

describe.serial("buildStaticTarget", () => {
  // ── B1: Tracer bullet ────────────────────────────────────────────────────────

  test("B1: pre-renders SSG root route to dist/index.html", async () => {
    const { distDir } = await runStaticBuild();
    expect(existsSync(join(distDir, "index.html"))).toBe(true);
  });

  // ── B2: nested SSG route ─────────────────────────────────────────────────────

  test("B2: pre-renders /blog/hello-world to dist/blog/hello-world/index.html", async () => {
    const { distDir } = await runStaticBuild();
    // cli-app has blog/[slug].tsx with staticParams: [{ slug: "hello-world" }]
    expect(existsSync(join(distDir, "blog/hello-world/index.html"))).toBe(true);
  });

  // ── B7: 404.html ─────────────────────────────────────────────────────────────

  test("B7: writes 404.html (SPA shell fallback for GitHub Pages)", async () => {
    const { distDir } = await runStaticBuild();
    expect(existsSync(join(distDir, "404.html"))).toBe(true);
  });

  // ── B6: dynamic SSG expands staticParams ─────────────────────────────────────

  test("B6: dynamic SSG with staticParams writes one file per variant", async () => {
    const { distDir } = await runStaticBuild();
    const htmlPath = join(distDir, "blog/hello-world/index.html");
    expect(existsSync(htmlPath)).toBe(true);
    const html = readFileSync(htmlPath, "utf8");
    expect(html).toContain("<!DOCTYPE html>");
  });

  // ── SPA-nav data files (so static deployments don't full-reload) ─────────────

  test("writes __furin_data.ndjson next to every prerendered HTML", async () => {
    // Without this file the client's SPA navigation falls back to fetching
    // /_furin/data?path=... — an endpoint that does not exist on a static
    // host (GitHub Pages, Vercel static, S3) and whose 404 HTML response is
    // unparseable by `parseDeferredNdjson`. The router-provider then bails
    // to a full reload on every link click. Pre-writing a parseable NDJSON
    // payload at a static-friendly URL fixes that.
    const { distDir } = await runStaticBuild();

    expect(existsSync(join(distDir, "__furin_data.ndjson"))).toBe(true);
    expect(existsSync(join(distDir, "blog/hello-world/__furin_data.ndjson"))).toBe(true);
  });

  test("__furin_data.ndjson is parseable by parseDeferredNdjson", async () => {
    const { distDir } = await runStaticBuild();
    const { parseDeferredNdjson } = await import("../src/deferred-ndjson.ts");

    const ndjsonText = readFileSync(join(distDir, "blog/hello-world/__furin_data.ndjson"), "utf8");
    // Recreate a stream from the file content so we exercise the same
    // `parseDeferredNdjson` API the SPA client uses on the live response body.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(ndjsonText));
        controller.close();
      },
    });
    const { syncData } = await parseDeferredNdjson(stream);
    // The fixture has no loader, so syncData is an empty object — not null,
    // not undefined. The crucial assertion is that parsing succeeds at all.
    expect(syncData).toBeInstanceOf(Object);
  });

  // ── B3: SSR + onSSR:"error" (default) → throw ────────────────────────────────

  test("B3: throws when SSR route present and onSSR is 'error' (default)", async () => {
    const app = makeApp("cli-app-ssr");
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const distDir = join(app.path, "dist");

    await expect(
      withBuildStub(() =>
        buildStaticTarget(routes, app.path, join(app.path, ".furin/build"), root, {
          target: "static",
          staticConfig: { outDir: distDir },
        })
      )
    ).rejects.toThrow(SSR_STATIC_RE);
  });

  // ── B9: multiple SSR routes → single error with full list ────────────────────

  test("B9: error message lists ALL non-SSG routes, not just the first", async () => {
    const app = makeApp("cli-app-ssr");
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const distDir = join(app.path, "dist");

    let errorMsg = "";
    try {
      await withBuildStub(() =>
        buildStaticTarget(routes, app.path, join(app.path, ".furin/build"), root, {
          target: "static",
          staticConfig: { outDir: distDir },
        })
      );
    } catch (err) {
      errorMsg = String(err);
    }

    // /dashboard is ssr — must appear in the error
    expect(errorMsg).toContain("/dashboard");
  });

  // ── B4: onSSR:"skip" → no throw, SSR route absent from output ────────────────

  test("B4: skips SSR routes without throwing when onSSR is 'skip'", async () => {
    const app = makeApp("cli-app-ssr");
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const distDir = join(app.path, "dist");

    // Must NOT throw
    await withBuildStub(() =>
      buildStaticTarget(routes, app.path, join(app.path, ".furin/build"), root, {
        target: "static",
        staticConfig: { outDir: distDir, onSSR: "skip" },
      })
    );

    // SSG pages are rendered, SSR dashboard is absent
    expect(existsSync(join(distDir, "index.html"))).toBe(true);
    expect(existsSync(join(distDir, "dashboard/index.html"))).toBe(false);
  });

  // ── B5: dynamic SSG without staticParams → warn + skip ───────────────────────

  test("B5: dynamic SSG route without staticParams is skipped without throwing", async () => {
    const app = makeApp("cli-app");
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const distDir = join(app.path, "dist");

    // Patch out staticParams on the dynamic route
    const patchedRoutes = routes.map((r) =>
      r.pattern.includes(":") ? { ...r, page: { ...r.page, staticParams: undefined } } : r
    );

    // Must NOT throw — just warn and skip
    await withBuildStub(() =>
      buildStaticTarget(patchedRoutes, app.path, join(app.path, ".furin/build"), root, {
        target: "static",
        staticConfig: { outDir: distDir },
      })
    );

    expect(existsSync(join(distDir, "index.html"))).toBe(true);
    expect(existsSync(join(distDir, "blog/hello-world/index.html"))).toBe(false);
  });

  // ── B8: basePath → asset paths use the prefixed value ────────────────────────

  test("B8: index.html asset references use basePath prefix when basePath is set", async () => {
    const app = makeApp("cli-app");
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const distDir = join(app.path, "dist");

    await withBuildStub(() =>
      buildStaticTarget(routes, app.path, join(app.path, ".furin/build"), root, {
        target: "static",
        staticConfig: { outDir: distDir, basePath: "/furin" },
      })
    );

    const html = readFileSync(join(distDir, "index.html"), "utf8");
    // JS/CSS chunks must reference /furin/_client/ not /_client/
    expect(html).toContain("/furin/_client/");
    expect(html).not.toContain('"/_client/');
  });

  // ── B10: basePath without leading slash → throws ──────────────────────────────

  test("B10: basePath without leading slash throws", async () => {
    const app = makeApp("cli-app");
    const { root, routes } = await scanPages(join(app.path, "src/pages"));

    await expect(
      buildStaticTarget(routes, app.path, join(app.path, ".furin/build"), root, {
        target: "static",
        staticConfig: { outDir: join(app.path, "dist"), basePath: "sub-path" },
      })
    ).rejects.toThrow(BASEPATH_RE);
  });

  // ── B11: basePath trailing slash is normalized ────────────────────────────────

  test("B11: basePath trailing slash is stripped before use", async () => {
    const app = makeApp("cli-app");
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const distDir = join(app.path, "dist");

    await withBuildStub(() =>
      buildStaticTarget(routes, app.path, join(app.path, ".furin/build"), root, {
        target: "static",
        staticConfig: { outDir: distDir, basePath: "/furin/" },
      })
    );

    const html = readFileSync(join(distDir, "index.html"), "utf8");
    expect(html).toContain("/furin/_client/");
    expect(html).not.toContain("/furin//_client/");
  });

  // ── B12: outDir === filesystem root → throws ──────────────────────────────────

  test("B12: outDir equal to filesystem root is rejected as unsafe", async () => {
    const app = makeApp("cli-app");
    const { root, routes } = await scanPages(join(app.path, "src/pages"));

    await expect(
      buildStaticTarget(routes, app.path, join(app.path, ".furin/build"), root, {
        target: "static",
        staticConfig: { outDir: "/" },
      })
    ).rejects.toThrow(UNSAFE_DIR_RE);
  });

  // ── B13: outDir === rootDir → throws ──────────────────────────────────────────

  test("B13: outDir same as rootDir is rejected as unsafe", async () => {
    const app = makeApp("cli-app");
    const { root, routes } = await scanPages(join(app.path, "src/pages"));

    await expect(
      buildStaticTarget(routes, app.path, join(app.path, ".furin/build"), root, {
        target: "static",
        staticConfig: { outDir: app.path },
      })
    ).rejects.toThrow(UNSAFE_DIR_RE);
  });

  // ── B14: outDir is an ancestor of rootDir → throws ───────────────────────────

  test("B14: outDir that contains rootDir as a descendant is rejected as unsafe", async () => {
    const app = makeApp("cli-app");
    const { root, routes } = await scanPages(join(app.path, "src/pages"));

    // Parent directory contains the app root — deleting it would wipe the app
    const parentDir = join(app.path, "..");

    await expect(
      buildStaticTarget(routes, app.path, join(app.path, ".furin/build"), root, {
        target: "static",
        staticConfig: { outDir: parentDir },
      })
    ).rejects.toThrow(UNSAFE_DIR_RE);
  });

  // ── B15: redirect from loader is silently skipped ────────────────────────────

  test("B15: route whose loader redirects is silently skipped (absent from rendered and skipped lists)", async () => {
    const app = makeApp("cli-app");
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const distDir = join(app.path, "dist");

    const baseRoute = routes.find((r) => r.mode === "ssg" && !r.pattern.includes(":"));
    if (!baseRoute) {
      throw new Error("cli-app fixture needs a static SSG route");
    }

    const redirectingRoute = {
      ...baseRoute,
      pattern: "/redirect-me",
      page: {
        ...baseRoute.page,
        loader: (): Promise<never> =>
          Promise.reject(new Response(null, { status: 302, headers: { Location: "/home" } })),
      },
    };

    const manifest = await withBuildStub(() =>
      buildStaticTarget(
        [redirectingRoute, ...routes.filter((r) => r.mode === "ssg")],
        app.path,
        join(app.path, ".furin/build"),
        root,
        { target: "static", staticConfig: { outDir: distDir } }
      )
    );

    expect(manifest.renderedRoutes).not.toContain("/redirect-me");
    expect(manifest.skippedRoutes).not.toContain("/redirect-me");
    expect(existsSync(join(distDir, "redirect-me/index.html"))).toBe(false);
  });

  // ── B16: prerender error → in skippedRoutes when onSSR=skip ──────────────────

  test("B16: prerender error records route in skippedRoutes when onSSR is skip", async () => {
    const app = makeApp("cli-app");
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const distDir = join(app.path, "dist");

    const baseRoute = routes.find((r) => r.mode === "ssg" && !r.pattern.includes(":"));
    if (!baseRoute) {
      throw new Error("cli-app fixture needs a static SSG route");
    }

    const failingRoute = {
      ...baseRoute,
      pattern: "/will-fail",
      page: {
        ...baseRoute.page,
        loader: (): Promise<never> => Promise.reject(new Error("prerender-boom")),
      },
    };

    const manifest = await withBuildStub(() =>
      buildStaticTarget(
        [failingRoute, ...routes.filter((r) => r.mode === "ssg")],
        app.path,
        join(app.path, ".furin/build"),
        root,
        { target: "static", staticConfig: { outDir: distDir, onSSR: "skip" } }
      )
    );

    expect(manifest.skippedRoutes).toContain("/will-fail");
    expect(manifest.renderedRoutes).not.toContain("/will-fail");
  });

  // ── B17: prerender error + onSSR=error → throws with failed route list ────────

  test("B17: prerender failure causes build to throw when onSSR is error (default)", async () => {
    const app = makeApp("cli-app");
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const distDir = join(app.path, "dist");

    const baseRoute = routes.find((r) => r.mode === "ssg" && !r.pattern.includes(":"));
    if (!baseRoute) {
      throw new Error("cli-app fixture needs a static SSG route");
    }

    const failingRoute = {
      ...baseRoute,
      pattern: "/will-fail",
      page: {
        ...baseRoute.page,
        loader: (): Promise<never> => Promise.reject(new Error("prerender-boom")),
      },
    };

    await expect(
      withBuildStub(() =>
        buildStaticTarget(
          [failingRoute, ...routes.filter((r) => r.mode === "ssg")],
          app.path,
          join(app.path, ".furin/build"),
          root,
          { target: "static", staticConfig: { outDir: distDir } }
        )
      )
    ).rejects.toThrow(PRERENDER_FAIL_RE);
  });

  // ── B18: staticParams() throws → route in skippedRoutes ──────────────────────

  test("B18: staticParams() that throws records the route in skippedRoutes", async () => {
    const app = makeApp("cli-app");
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const distDir = join(app.path, "dist");

    const dynamicRoute = routes.find((r) => r.pattern.includes(":"));
    if (!dynamicRoute) {
      throw new Error("cli-app fixture needs a dynamic route");
    }

    const patchedRoutes = routes.map((r) =>
      r.pattern === dynamicRoute.pattern
        ? {
            ...r,
            page: {
              ...r.page,
              staticParams: (): Promise<never> => Promise.reject(new Error("staticParams-boom")),
            },
          }
        : r
    );

    const manifest = await withBuildStub(() =>
      buildStaticTarget(patchedRoutes, app.path, join(app.path, ".furin/build"), root, {
        target: "static",
        staticConfig: { outDir: distDir },
      })
    );

    expect(manifest.skippedRoutes).toContain(dynamicRoute.pattern);
  });

  // ── B19: path traversal via staticParams → throws ────────────────────────────

  test("B19: staticParams returning a path-traversal slug throws unsafe output path error", async () => {
    const app = makeApp("cli-app");
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const distDir = join(app.path, "dist");

    const dynamicRoute = routes.find((r) => r.pattern.includes(":"));
    if (!dynamicRoute) {
      throw new Error("cli-app fixture needs a dynamic route");
    }

    const patchedRoutes = routes.map((r) =>
      r.pattern === dynamicRoute.pattern
        ? {
            ...r,
            page: {
              ...r.page,
              staticParams: async () => [{ slug: "../../etc/passwd" }],
            },
          }
        : r
    );

    await expect(
      withBuildStub(() =>
        buildStaticTarget(patchedRoutes, app.path, join(app.path, ".furin/build"), root, {
          target: "static",
          staticConfig: { outDir: distDir },
        })
      )
    ).rejects.toThrow(UNSAFE_PATH_RE);
  });
});
