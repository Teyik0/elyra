import type { Context } from "elysia";
import type { SearchRouteMetadata } from "../../shared/search-params.ts";
import { autoInvalidateRegistry } from "../auto-invalidate/registry.ts";
import { type Cache, createRouteCache, type RevalidateType } from "../cache/route-cache.ts";
import type { ResolvedRoute, RootLayout } from "../router/index.ts";
import { resolvePath } from "./assemble.ts";
import { type LoaderResult, runPublicLoaders, runRequestLoaderData } from "./loaders.ts";
import { renderSSR } from "./ssr.ts";

interface CachedPprRoute {
  generatedAt: number;
  publicResult: Extract<LoaderResult, { type: "data" }>;
  revalidate: number;
}

const MAX_PPR_ROUTE_CACHE_SIZE = 1000;

const pprRoutesByRoot = new Map<RootLayout, Cache<CachedPprRoute>>();

function pathFromPprCacheKey(key: string): string | null {
  const separator = key.indexOf(":");
  if (separator === -1) {
    return null;
  }
  return new URL(key.slice(separator + 1), "http://furin.local").pathname;
}

function getPprRoutes(root: RootLayout): Cache<CachedPprRoute> {
  let routes = pprRoutesByRoot.get(root);
  if (routes === undefined) {
    routes = createRouteCache<CachedPprRoute>({
      maxSize: MAX_PPR_ROUTE_CACHE_SIZE,
      name: "render:ppr-public-shell",
      pathFromKey: pathFromPprCacheKey,
    });
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
  const response = await renderSSR(route, ctx, root, actualResult, searchRoutes);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export function clearPprRouteCache(): void {
  pprRoutesByRoot.clear();
}

export function invalidatePprRoute(path: string, type: RevalidateType): boolean {
  let deleted = false;
  for (const pprRoutes of pprRoutesByRoot.values()) {
    deleted = pprRoutes.invalidatePath(path, type).deleted || deleted;
  }
  return deleted;
}
