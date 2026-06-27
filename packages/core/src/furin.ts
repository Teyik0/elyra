import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { staticPlugin } from "@elysiajs/static";
import { type AnyElysia, Elysia, file } from "elysia";
import { type DrainContext, initLogger } from "evlog";
import { type EvlogElysiaOptions, evlog } from "evlog/elysia";
import {
  _runWithRequestInvalidationScope,
  consumePendingInvalidations,
  getBuildId,
  setBuildId,
} from "./server/cache/invalidation.ts";
import { setSSGCache } from "./server/cache/ssg.ts";
import type { CompileContext, EmbeddedAppData } from "./server/internal.ts";
import { getCompileContext } from "./server/internal.ts";
import { renderRootNotFound, warmSSGCache } from "./server/render/index.ts";
import {
  setProductionTemplateContent,
  setProductionTemplatePath,
} from "./server/render/template.ts";
import {
  createDataEndpoint,
  createRoutePlugin,
  createSearchRouteMetadata,
  loadProdRoutes,
} from "./server/router/index.ts";
import { IS_DEV } from "./server/runtime-env.ts";
import {
  createSyncStreamPlugin,
  type FurinSyncOption,
  resolveSyncStreamPath,
  runWithSyncStreamPath,
} from "./server/sync/index.ts";

// biome-ignore lint/suspicious/noEmptyInterface: intentionally augmentable via furin-env.d.ts
export interface FurinCacheTags {}

export type CacheTag = keyof FurinCacheTags extends never ? string : keyof FurinCacheTags;

function resolveClientDirFromArgv(): string {
  return (
    resolveClientDirFromEnv() ??
    resolveClientDirFromModuleUrl() ??
    resolveClientDirFromProcessArgs() ??
    resolveFallbackClientDir()
  );
}

function resolveClientDirFromEnv(): string | null {
  const envClientDir = process.env.FURIN_CLIENT_DIR;
  if (!envClientDir) {
    return null;
  }
  return envClientDir.startsWith("/") ? envClientDir : resolve(process.cwd(), envClientDir);
}

function resolveClientDirFromModuleUrl(): string | null {
  try {
    const moduleUrl = new URL(import.meta.url);
    if (moduleUrl.protocol !== "file:") {
      return null;
    }
    const modulePath = fileURLToPath(moduleUrl);
    if (modulePath.includes("/$bunfs/")) {
      return null;
    }
    const moduleClientDir = join(dirname(modulePath), "client");
    if (existsSync(join(moduleClientDir, "index.html"))) {
      return moduleClientDir;
    }
  } catch {
    // ignore, fallback to argv-based resolution
  }
  return null;
}

function resolveClientDirFromProcessArgs(): string | null {
  const candidates = [
    process.argv[1],
    process.argv[0],
    (process as { argv0?: string }).argv0,
    process.execPath,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  for (const candidate of candidates) {
    const resolved = resolveClientDirFromCandidate(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

function resolveClientDirFromCandidate(candidate: string): string | null {
  const name = basename(candidate);
  if (name === "bun" || name === "node") {
    return null;
  }
  if (candidate.includes("/$bunfs/") || candidate.startsWith("bunfs:")) {
    return null;
  }

  const absolute = candidate.startsWith("/") ? candidate : resolve(process.cwd(), candidate);
  if (existsSync(absolute)) {
    return join(dirname(absolute), "client");
  }

  if (!candidate.includes("/")) {
    return resolveClientDirFromPath(candidate);
  }

  return null;
}

function resolveClientDirFromPath(candidate: string): string | null {
  const pathEntries = process.env.PATH?.split(":") ?? [];
  for (const dir of pathEntries) {
    const fullPath = join(dir, candidate);
    if (existsSync(fullPath)) {
      return join(dirname(fullPath), "client");
    }
  }
  return null;
}

function resolveFallbackClientDir(): string {
  const defaultClientDir = resolve(process.cwd(), ".furin/build/bun/client");
  if (existsSync(join(defaultClientDir, "index.html"))) {
    return defaultClientDir;
  }

  return join(process.cwd(), "client");
}

async function setupProdTemplate(
  embedded: EmbeddedAppData | undefined,
  clientDir: string
): Promise<void> {
  if (embedded) {
    if (!embedded.template) {
      throw new Error("[furin] Embedded app is missing its HTML template (index.html).");
    }
    const html = await Bun.file(embedded.template).text();
    setProductionTemplateContent(html);
    return;
  }

  const templatePath = join(clientDir, "index.html");
  if (!existsSync(templatePath)) {
    throw new Error("[furin] No pre-built assets found. Run `bun run build` first.");
  }
  setProductionTemplatePath(templatePath);
}

/**
 * Registers a HigherOrderFunction on the Elysia instance so that every request
 * runs inside a fresh `AsyncLocalStorage` scope. This isolates
 * `pendingInvalidations` per request, preventing concurrent requests from
 * stealing each other's `revalidatePath()` calls.
 *
 * Uses `app.wrap()` (Elysia HigherOrderFunction) instead of mutating
 * `app.handle`, because handle mutations are lost when the Furin plugin is
 * `.use()`-d by a parent Elysia instance. HigherOrderFunctions survive the
 * plugin merge and wrap the entire composed `map` handler.
 */
function wrapWithRequestScope(app: AnyElysia, syncStreamPath: string | undefined): Elysia {
  return app.wrap(
    (handler, _request) => (ctx: unknown) =>
      runWithSyncStreamPath(syncStreamPath, () =>
        _runWithRequestInvalidationScope(() => handler(ctx))
      )
  );
}

function hydrateSSGCacheFromCompileContext(ctx: CompileContext): void {
  if (!ctx.ssgCache) {
    return;
  }
  for (const [path, entry] of Object.entries(ctx.ssgCache)) {
    setSSGCache(path, entry);
  }
}

/**
 * Main Furin plugin.
 *
 * Returns a standalone Elysia instance (async function) so that routes are
 * properly registered in Elysia's router for SPA navigation to work.
 *
 * ## Usage
 *
 * ```ts
 * new Elysia()
 *   .use(await furin({ ... }))
 *   .listen(3000)
 * ```
 */
export async function furin({
  pagesDir,
  logger,
  clientLogging,
  sync,
}: {
  pagesDir?: string;
  logger?: EvlogElysiaOptions;
  /**
   * Initialize the browser HTTP log drain in the hydration entry. Off by
   * default — enabling it adds `evlog/http` drain setup and points browser
   * events at `/_furin/ingest`. Server-side logging is configured via `logger`
   * and unaffected.
   */
  clientLogging?: boolean;
  /**
   * Enables Furin's built-in sync event stream. The opinionated default mounts
   * Server-Sent Events at `/_furin/sync`; pass an object only for constrained
   * reverse-proxy deployments that need a custom internal path.
   */
  sync?: FurinSyncOption;
}) {
  const syncStreamPath = resolveSyncStreamPath(sync);
  const { exclude: userExclude, ...evlogOptions } = logger ?? {};
  initLogger({ env: { service: "furin" } });

  const loggerPlugin = new Elysia()
    .use(
      evlog({
        ...evlogOptions,
        exclude: [
          "/_client/**",
          "/public/**",
          "/favicon.ico",
          "/_bun_hmr_entry/**",
          ...(syncStreamPath ? [syncStreamPath] : []),
          // Note: /_furin/data is logged with the *logical* path rewritten by
          // createDataEndpoint via useLogger().set({ path }), so SPA navigations
          // appear as "GET /board/123 200" — same shape as a normal SSR nav.
          // /_furin/ingest is kept loggable so browser-side events show up.
          // evlog's `matchesPattern` only supports `*`, `**`, `?` — extglob
          // like `!(...)` matches nothing, so don't add patterns relying on it.
          ...(userExclude ?? []),
        ],
      })
    )
    .post(
      "/_furin/ingest",
      ({ body, log, status }) => {
        if (!Array.isArray(body)) {
          return status("Bad Request");
        }
        // Cap batch size to prevent abuse
        const batch = (body as DrainContext[]).slice(0, 100);
        for (const entry of batch) {
          if (!entry || typeof entry !== "object" || !("event" in entry)) {
            log.set({ msg: "[furin] ingest: skipping malformed entry" });
            continue;
          }
          // Pick only safe, known fields from the event to prevent prototype pollution
          const event = entry.event as Record<string, unknown> | undefined;
          if (!event || typeof event !== "object") {
            continue;
          }
          const {
            __proto__,
            constructor: _ctor,
            prototype,
            environment: _browserEnv,
            ...safeEvent
          } = event as Record<string, unknown>;
          log.set({ ...safeEvent, service: "furin:browser" });
        }
        return status("No Content");
      },
      { parse: "json" }
    );

  const cwd = process.cwd();
  const ctx = getCompileContext();
  const resolvedPagesDir = ctx?.rootPath
    ? dirname(ctx.rootPath)
    : resolve(cwd, pagesDir ?? "src/pages");

  // Unique name per pagesDir to avoid Elysia's name-based plugin dedup.
  const instanceName = `furin-${resolvedPagesDir.replaceAll("\\", "/")}`;

  // ── Dev: Bun native HMR ────────────────────────────────────────────────
  if (IS_DEV) {
    const furinDir = resolve(cwd, ".furin");
    // Lazy import — build pipeline has native deps not available in compiled binaries
    const { registerDevPagePlugin } = await import("./server/dev-page-plugin.ts");
    registerDevPagePlugin();

    const { createDevInspectorPlugin } = await import("./server/dev-inspector.ts");

    const { scanPages } = await import("./server/router/index.ts");
    const { root, routes } = await scanPages(resolvedPagesDir);
    const searchRoutes = createSearchRouteMetadata(routes);

    const { writeDevFiles } = await import("./build/hydrate.ts");
    writeDevFiles(
      routes,
      {
        outDir: furinDir,
        rootLayout: root.path,
        basePath: "",
        publicPath: "/_client/",
        clientLogging: clientLogging ?? false,
      },
      cwd
    );

    const publicDir = resolve(cwd, "public");
    const publicExists = existsSync(publicDir);

    const devApp = new Elysia({ name: instanceName, seed: resolvedPagesDir })
      .use(loggerPlugin)
      .onError({ as: "global" }, async ({ code, request }) => {
        if (code === "NOT_FOUND") {
          return await renderRootNotFound(root, request);
        }
      })
      .onAfterHandle({ as: "global" }, ({ set }) => {
        // Forward pending revalidation paths so the client can bust its prefetch cache
        const pending = consumePendingInvalidations();
        if (pending.length > 0) {
          set.headers["x-furin-revalidate"] = pending.join(",");
        }
      })
      .use(await staticPlugin({ assets: furinDir, prefix: "/_bun_hmr_entry", bunFullstack: true }))
      .use(
        publicExists ? await staticPlugin({ assets: publicDir, prefix: "/public" }) : new Elysia()
      )
      .get(
        "/favicon.ico",
        publicExists
          ? file(join(publicDir, "favicon.ico"))
          : () => new Response(null, { status: 404 })
      )
      .use(createDevInspectorPlugin())
      .use(syncStreamPath ? createSyncStreamPlugin(syncStreamPath) : new Elysia())
      .use(createDataEndpoint(routes))
      .use((app) => {
        for (const route of routes) {
          app.use(createRoutePlugin(route, root, undefined, searchRoutes));
        }
        return app;
      });
    return wrapWithRequestScope(devApp, syncStreamPath);
  }

  // ── Production ──────────────────────────────────────────────────────────
  if (!ctx) {
    throw new Error("[furin] No pre-built assets found. Run `bunx furin build` first.");
  }
  const { root, routes } = loadProdRoutes(ctx);
  const searchRoutes = createSearchRouteMetadata(routes);
  const prodBuildId = ctx.buildId ?? "";
  setBuildId(prodBuildId);
  hydrateSSGCacheFromCompileContext(ctx);

  const embedded = ctx?.embedded;
  const clientDir = embedded ? "" : resolveClientDirFromArgv();
  await setupProdTemplate(embedded, clientDir);

  const prodApp = new Elysia({ name: instanceName, seed: resolvedPagesDir })
    .use(loggerPlugin)
    .onError({ as: "global" }, async ({ code, request }) => {
      if (code === "NOT_FOUND") {
        return await renderRootNotFound(root, request);
      }
    })
    .onAfterHandle({ as: "global" }, ({ path, set }) => {
      // Content-hashed client assets are permanently cacheable — browsers never need to
      // revalidate them because any change produces a new filename.
      if (path.startsWith("/_client/")) {
        set.headers["cache-control"] = "public, max-age=31536000, immutable";
      }
      // Forward pending revalidation paths so the client can bust its prefetch cache
      const pending = consumePendingInvalidations();
      if (pending.length > 0) {
        set.headers["x-furin-revalidate"] = pending.join(",");
      }
      // Tell the client the current build ID so it can detect stale deploys
      const buildId = getBuildId();
      if (buildId) {
        set.headers["x-furin-build-id"] = buildId;
      }
    })
    .onStart(async ({ server }) => {
      if (ctx.ssgCache) {
        return;
      }
      const origin = server?.url?.origin ?? "http://localhost:3000";
      await warmSSGCache(routes, root, origin, searchRoutes);
    })
    .use(
      await (async () => {
        if (embedded) {
          return new Elysia()
            .get("/favicon.ico", ({ status }) => {
              const asset = embedded.assets["/public/favicon.ico"];
              if (!asset) {
                return status("Not Found");
              }
              return Bun.file(asset);
            })
            .get("/_client/*", ({ params, status }) => {
              const asset = embedded.assets[`/_client/${params["*"]}`];
              if (!asset) {
                return status("Not Found");
              }
              return Bun.file(asset);
            })
            .get("/public/*", ({ params, status }) => {
              const asset = embedded.assets[`/public/${params["*"]}`];
              if (!asset) {
                return status("Not Found");
              }
              return Bun.file(asset);
            });
        }
        const publicDir = join(dirname(clientDir), "public");
        const app = new Elysia();
        if (existsSync(publicDir)) {
          app
            .get("/favicon.ico", file(join(publicDir, "favicon.ico")))
            .use(await staticPlugin({ assets: publicDir, prefix: "/public" }));
        }
        app.use(await staticPlugin({ assets: clientDir, prefix: "/_client" }));
        return app;
      })()
    )
    .use(syncStreamPath ? createSyncStreamPlugin(syncStreamPath) : new Elysia())
    .use(createDataEndpoint(routes))
    .use((app) => {
      for (const route of routes) {
        app.use(createRoutePlugin(route, root, prodBuildId, searchRoutes));
      }
      return app;
    });
  return wrapWithRequestScope(prodApp, syncStreamPath);
}

// biome-ignore lint/performance/noBarrelFile: furin.ts is the public package entry
export { FurinErrorBoundary, FurinNotFoundBoundary } from "./client/boundaries.tsx";
// ── Public API re-export ──────────────────────────────────────────────────────
// biome-ignore-start lint/performance/noBarrelFile: intentional — furin.ts is the public package entry
export type { DeferredData, RuntimePage, RuntimeRoute } from "./client.ts";
export { defer, isDeferred } from "./client.ts";
export type { InvalidationInput, InvalidationRule } from "./server/auto-invalidate/index.ts";
export { furinInvalidate, revalidateTag } from "./server/auto-invalidate/index.ts";
export { revalidatePath, setCachePurger } from "./server/cache/invalidation.ts";
export { buildElement, buildErrorElement, renderRootNotFound } from "./server/render/index.ts";
export type { ResolvedRoute, SegmentBoundary } from "./server/router/index.ts";
export { furinSync, type SyncInput, type SyncRouteOption } from "./server/sync/index.ts";
export { Await, useAsyncError, useAsyncValue } from "./shared/await.tsx";
export type { ErrorComponent, ErrorProps } from "./shared/error.ts";
export type {
  NotFoundComponent,
  NotFoundOptions,
  NotFoundProps,
} from "./shared/not-found.ts";
export { isNotFoundError, notFound } from "./shared/not-found.ts";
// biome-ignore-end lint/performance/noBarrelFile: intentional — furin.ts is the public package entry
