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

  const ssgRoutes = routes.filter(
    (route): route is ResolvedRoute & { page: { staticParams: NonNullable<ResolvedRoute["page"]["staticParams"]> } } =>
      route.mode === "ssg" && !!route.page.staticParams
  );
  const paramSetsResults = await Promise.all(ssgRoutes.map((route) => route.page.staticParams()));
  const prerenderTasks: Promise<void>[] = [];
  for (let i = 0; i < ssgRoutes.length; i++) {
    const route = ssgRoutes[i];
    const paramSets = paramSetsResults[i];
    if (!route || !paramSets) {
      continue;
    }
    for (const params of paramSets) {
      prerenderTasks.push(
        prerenderSSG(route, params, root, origin, undefined, searchRoutes).then((entry) => {
          if (entry instanceof Response) {
            return;
          }
          snapshot[resolvePath(route.pattern, params)] = entry;
        })
      );
    }
  }
  await Promise.all(prerenderTasks);

  return snapshot;
}
