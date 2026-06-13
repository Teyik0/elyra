import type { SsgCacheEntry } from "../server/cache/index.ts";
import { prerenderSSG } from "../server/render/index.ts";
import { createSearchRouteMetadata, type ResolvedRoute, type RootLayout } from "../server/router/index.ts";
import { resolvePath } from "../server/render/assemble.ts";

export type SSGCacheSnapshot = Record<string, SsgCacheEntry>;

export async function buildSSGCacheSnapshot(
  routes: ResolvedRoute[],
  root: RootLayout,
  origin: string
): Promise<SSGCacheSnapshot> {
  const snapshot: SSGCacheSnapshot = {};
  const searchRoutes = createSearchRouteMetadata(routes);

  for (const route of routes) {
    if (route.mode !== "ssg" || !route.page.staticParams) {
      continue;
    }

    const paramSets = await route.page.staticParams();
    for (const params of paramSets) {
      const entry = await prerenderSSG(route, params, root, origin, undefined, searchRoutes);
      if (entry instanceof Response) {
        continue;
      }
      snapshot[resolvePath(route.pattern, params)] = entry;
    }
  }

  return snapshot;
}
