import type { Context } from "elysia";
import type { SearchRouteMetadata } from "../../shared/search-params.ts";
import { autoInvalidateRegistry } from "../auto-invalidate/registry.ts";
import type { RevalidateType } from "../cache/route-cache.ts";
import type { ResolvedRoute, RootLayout } from "../router/index.ts";
import { resolvePath } from "./assemble.ts";
import { type LoaderResult, runPublicLoaders, runRequestLoaderData } from "./loaders.ts";
import { renderSSR } from "./ssr.ts";

interface CachedPprRoute {
  generatedAt: number;
  publicResult: Extract<LoaderResult, { type: "data" }>;
  revalidate: number;
}

const pprRoutesByRoot = new Map<RootLayout, Map<string, CachedPprRoute>>();

function getPprRoutes(root: RootLayout): Map<string, CachedPprRoute> {
  let routes = pprRoutesByRoot.get(root);
  if (routes === undefined) {
    routes = new Map();
    pprRoutesByRoot.set(root, routes);
  }
  return routes;
}

async function buildPublicEntry(route: ResolvedRoute, ctx: Context): Promise<CachedPprRoute> {
  const result = await runPublicLoaders(route, ctx);
  if (result.type !== "data") {
    throw result.type === "redirect" ? result.response : result.error;
  }
  return {
    generatedAt: Date.now(),
    publicResult: result,
    revalidate: route.page._route.revalidate ?? 60,
  };
}

export async function renderPprRoute(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  _buildId: string,
  searchRoutes: SearchRouteMetadata[] | undefined
): Promise<Response> {
  const requestUrl = new URL(ctx.request.url);
  const cacheKey = `${route.mode}:${resolvePath(route.pattern, ctx.params ?? {})}${requestUrl.search}`;
  const pprRoutes = getPprRoutes(root);
  let cached = pprRoutes.get(cacheKey);
  if (cached === undefined) {
    cached = await buildPublicEntry(route, ctx);
    pprRoutes.set(cacheKey, cached);
    autoInvalidateRegistry.registerLoaderTags(
      resolvePath(route.pattern, ctx.params ?? {}),
      route.tags
    );
  } else if (route.mode === "isr" && Date.now() - cached.generatedAt >= cached.revalidate * 1000) {
    buildPublicEntry(route, ctx)
      .then((entry) => pprRoutes.set(cacheKey, entry))
      .catch(() => {
        /* Atomic ISR: retain the previous good public shell. */
      });
  }

  const requestData = runRequestLoaderData(route, ctx);
  if (requestData === undefined) {
    throw new Error("[furin] internal PPR invariant: requestLoader is missing");
  }
  const actualResult: Extract<LoaderResult, { type: "data" }> = {
    ...cached.publicResult,
    deferredPromises: {
      ...(cached.publicResult.deferredPromises ?? {}),
      requestData,
    },
  };
  return renderSSR(route, ctx, root, actualResult, searchRoutes);
}

export function clearPprRouteCache(): void {
  pprRoutesByRoot.clear();
}

export function invalidatePprRoute(path: string, type: RevalidateType): boolean {
  let deleted = false;
  for (const pprRoutes of pprRoutesByRoot.values()) {
    for (const key of pprRoutes.keys()) {
      const routePath = new URL(key.slice(key.indexOf(":") + 1), "http://furin.local").pathname;
      const matches =
        type === "layout"
          ? routePath === path || routePath.startsWith(path.endsWith("/") ? path : `${path}/`)
          : routePath === path;
      if (matches) {
        deleted = pprRoutes.delete(key) || deleted;
      }
    }
  }
  return deleted;
}
