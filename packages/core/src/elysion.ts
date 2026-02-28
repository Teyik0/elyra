import { resolve } from "node:path";
import { staticPlugin } from "@elysiajs/static";
import type { StaticOptions } from "@elysiajs/static/types";
import type { AnyElysia } from "elysia";
import { buildClient, writeDevFiles } from "./build";
import { registerBunStripPlugin } from "./bun-strip-plugin";
import { createRoutePlugin, scanPages } from "./router";

export interface ElysionProps {
  dev?: boolean;
  pagesDir?: string;
  staticOptions: StaticOptions<string>;
}

/**
 * Main Elysion plugin.
 *
 * Returns a callback plugin `(app: Elysia) => Elysia` instead of an Elysia
 * instance, so it integrates cleanly with the parent app.
 *
 * ## Dev mode (Bun native HMR)
 *
 * The user's server.ts must statically import `.elysion/index.html` and
 * register it in serve.routes — this is what triggers Bun's HTML bundler,
 * module graph, HMR WebSocket, and React Fast Refresh.
 *
 * ```ts
 * // server.ts
 * import elysionHtml from "../.elysion/index.html";
 *
 * new Elysia({ serve: { routes: { "/_bun_entry": elysionHtml } } })
 *   .use(await elysion({ ... }))
 *   .listen(3000);
 * ```
 *
 * Run `bun run scripts/generate.ts` before starting the server to generate
 * `.elysion/_hydrate.tsx`.  The `dev` package.json script handles this:
 * `"dev": "bun run scripts/generate.ts && bun --hot src/server.ts"`
 *
 * ## Production mode
 *
 * `elysion()` runs `Bun.build()` to produce `.elysion/client/index.html`
 * (the SSR template) plus hashed JS/CSS chunks.  No static import needed.
 */
export async function elysion({
  pagesDir,
  staticOptions,
  dev = process.env.NODE_ENV !== "production",
}: ElysionProps): Promise<(app: AnyElysia) => AnyElysia> {
  const cwd = process.cwd();
  const resolvedPagesDir = resolve(cwd, pagesDir ?? "./src/pages");

  const { root, routes } = await scanPages(resolvedPagesDir, dev);

  if (!root) {
    console.warn(
      "[elysion] No root.tsx found. Create a root.tsx in your pages directory " +
        "with a layout component."
    );
  }

  console.log(
    `[elysion] Configuration: ${routes.length} page(s) — ${dev ? "dev (Bun HMR)" : "production"}`
  );
  for (const route of routes) {
    const hasLayout = route.routeChain.some((r) => r.layout);
    console.log(
      `  ${route.mode.toUpperCase().padEnd(4)} ${route.pattern}${hasLayout ? " + layout" : ""}`
    );
  }

  // ── Dev: Bun native HMR ──────────────────────────────────────────────────
  if (dev) {
    const elysionDir = resolve(cwd, ".elysion");

    // 1. Register the Bun build plugin that strips server-only code from pages
    //    and stubs elysia.  Must happen before the static HTML import in the
    //    user's server.ts is evaluated (works because elysion() is awaited at
    //    module top-level before the import is resolved by Bun).
    registerBunStripPlugin(resolvedPagesDir);

    // 2. Regenerate .elysion/_hydrate.tsx with the current page list.
    //    Only writes when content changed so Bun --hot doesn't reload needlessly.
    writeDevFiles(routes, { outDir: elysionDir, rootPath: root?.path ?? null });

    const userStaticPlugin = await staticPlugin(staticOptions);

    const routePlugins = routes.map((route) => createRoutePlugin(route, staticOptions, root, dev));

    return function elysionDevPlugin(app: AnyElysia): AnyElysia {
      let result = app.use(userStaticPlugin);
      for (const plugin of routePlugins) {
        result = result.use(plugin);
      }
      return result;
    };
  }

  // ── Production ───────────────────────────────────────────────────────────
  const elysionDir = resolve(cwd, ".elysion");
  await buildClient(routes, { dev: false, outDir: elysionDir, rootPath: root?.path ?? null });

  const clientStaticPlugin = await staticPlugin({
    assets: resolve(cwd, ".elysion", "client"),
    prefix: "/_client",
  });
  const userStaticPlugin = await staticPlugin(staticOptions);
  const routePlugins = routes.map((route) => createRoutePlugin(route, staticOptions, root, dev));

  return function elysionProdPlugin(app: AnyElysia): AnyElysia {
    let result = app.use(clientStaticPlugin).use(userStaticPlugin);
    for (const plugin of routePlugins) {
      result = result.use(plugin);
    }
    return result;
  };
}

import.meta.hot.accept();
