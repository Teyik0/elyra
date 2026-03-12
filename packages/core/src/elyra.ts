import { resolve } from "node:path";
import { staticPlugin } from "@elysiajs/static";
import { Elysia } from "elysia";
// Lightweight manifest reader — no native-addon deps (safe in compiled binaries)
import { readTargetBuildManifest } from "./build/manifest";
import type { TargetBuildManifest } from "./build/types";
import type { EmbeddedAppData } from "./internal";
import { getCompileContext } from "./internal";
import { warmSSGCache } from "./render/index";
import { setProductionTemplateContent, setProductionTemplatePath } from "./render/template";
import type { ResolvedRoute, RootLayout } from "./router";
import { createRoutePlugin, scanPages } from "./router";
import { IS_DEV } from "./runtime-env";

export interface ElysionProps {
  pagesDir?: string;
}

async function setupProdTemplate(
  embedded: EmbeddedAppData | undefined,
  prebuiltManifest: TargetBuildManifest | null,
  elysionDir: string,
  cwd: string,
  routes: ResolvedRoute[],
  root: RootLayout
): Promise<void> {
  if (embedded) {
    if (!embedded.template) {
      throw new Error("[elyra] Embedded app is missing its HTML template (index.html).");
    }
    const html = await Bun.file(embedded.template).text();
    setProductionTemplateContent(html);
  } else if (prebuiltManifest) {
    setProductionTemplatePath(resolve(cwd, prebuiltManifest.templatePath));
  } else {
    setProductionTemplatePath(null);
    // Lazy import — build pipeline has native deps not available in compiled binaries
    const { buildClient } = await import("./build/client");
    await buildClient(routes, { outDir: elysionDir, rootLayout: root.path });
  }
}

function buildEmbedInstance(
  instanceName: string,
  resolvedPagesDir: string,
  embedded: EmbeddedAppData
): Elysia {
  const { assets } = embedded;
  // Explicit wildcard route — lifecycle hooks don't fire for unmatched routes.
  return new Elysia({ name: instanceName, seed: resolvedPagesDir }).get(
    "/_client/*",
    ({ params }) => {
      const filePath = assets[`/_client/${params["*"]}`];
      return filePath
        ? new Response(Bun.file(filePath))
        : new Response("Not Found", { status: 404 });
    }
  ) as unknown as Elysia;
}

async function buildDiskInstance(
  instanceName: string,
  resolvedPagesDir: string,
  prebuiltManifest: TargetBuildManifest | null,
  cwd: string
): Promise<Elysia> {
  const clientDir = prebuiltManifest
    ? resolve(cwd, prebuiltManifest.clientDir)
    : resolve(cwd, ".elyra", "client");
  return new Elysia({ name: instanceName, seed: resolvedPagesDir })
    .use(await staticPlugin())
    .use(await staticPlugin({ assets: clientDir, prefix: "/_client" }));
}

/**
 * Main Elyra plugin.
 *
 * Returns a standalone Elysia instance (async function) so that routes are
 * properly registered in Elysia's router for SPA navigation to work.
 *
 * ## Usage
 *
 * ```ts
 * new Elysia()
 *   .use(await elyra({ ... }))
 *   .listen(3000)
 * ```
 */
export async function elyra({ pagesDir }: ElysionProps) {
  const cwd = process.cwd();
  const resolvedPagesDir = resolve(cwd, pagesDir ?? "src/pages");
  // Unique name per pagesDir to avoid Elysia's name-based plugin dedup.
  const instanceName = `elyra-${resolvedPagesDir.replaceAll("\\", "/")}`;
  const buildTarget = process.env.ELYRA_BUILD_TARGET;
  const buildOutDir = process.env.ELYRA_BUILD_OUT_DIR;
  const prebuiltManifest =
    !IS_DEV && buildTarget === "bun" ? readTargetBuildManifest(cwd, "bun", buildOutDir) : null;

  const { root, routes } = await scanPages(resolvedPagesDir);

  console.info(
    `[elyra] Configuration: ${routes.length} page(s) — ${IS_DEV ? "dev (Bun HMR)" : "production"}`
  );
  for (const route of routes) {
    const hasLayout = route.routeChain.some((r) => r.layout);
    console.info(
      `  ${route.mode.toUpperCase().padEnd(4)} ${route.pattern}${hasLayout ? " + layout" : ""}`
    );
  }

  // ── Dev: Bun native HMR ────────────────────────────────────────────────
  if (IS_DEV) {
    const elysionDir = resolve(cwd, ".elyra");
    // Lazy import — build pipeline has native deps not available in compiled binaries
    const { writeDevFiles } = await import("./build/hydrate");
    writeDevFiles(routes, { outDir: elysionDir, rootLayout: root.path });

    let instance = new Elysia({ name: instanceName, seed: resolvedPagesDir })
      .use(await staticPlugin({ assets: elysionDir, prefix: "/_bun_hmr_entry" }))
      .use(await staticPlugin());

    for (const route of routes) {
      instance = instance.use(createRoutePlugin(route, root));
    }

    return instance;
  }

  // ── Production ──────────────────────────────────────────────────────────
  const defaultProdDir = resolve(cwd, ".elyra");
  const elysionDir = prebuiltManifest ? resolve(cwd, prebuiltManifest.targetDir) : defaultProdDir;
  const embedded = getCompileContext()?.embedded;

  await setupProdTemplate(embedded, prebuiltManifest, elysionDir, cwd, routes, root);

  let instance = embedded
    ? buildEmbedInstance(instanceName, resolvedPagesDir, embedded)
    : await buildDiskInstance(instanceName, resolvedPagesDir, prebuiltManifest, cwd);

  for (const route of routes) {
    instance = instance.use(createRoutePlugin(route, root));
  }

  // Pre-render SSG routes with staticParams before the first request arrives.
  const ssgTargets = routes.filter((r) => r.mode === "ssg" && r.page?.staticParams);
  if (ssgTargets.length > 0) {
    instance = instance.onStart(async ({ server }) => {
      const origin = server?.url?.origin ?? "http://localhost:3000";
      console.log(`[elyra] Warming SSG cache for ${ssgTargets.length} route(s)…`);
      await warmSSGCache(ssgTargets, root, origin);
      console.log("[elyra] SSG warm-up complete.");
    });
  }

  return instance;
}
