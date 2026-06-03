import { mapWithConcurrency } from "../../shared/utils.ts";
import { autoInvalidateRegistry } from "../auto-invalidate/registry.ts";
import type { SsgCacheEntry } from "../cache/isr-ssg.ts";
import { getSSGCache, setSSGCache } from "../cache/ssg.ts";
import { createLogger } from "../context-logger.ts";
import type { ResolvedRoute, RootLayout } from "../router/index.ts";
import { resolvePath } from "./assemble.ts";
import { renderForPath } from "./ssr.ts";

export async function prerenderSSG(
  route: ResolvedRoute,
  params: Record<string, string>,
  root: RootLayout,
  origin: string,
  basePath: string | undefined
): Promise<SsgCacheEntry | Response> {
  const resolvedPath = resolvePath(route.pattern, params);

  const cached = getSSGCache(resolvedPath);
  if (cached) {
    return cached;
  }

  const renderResult = await renderForPath(route, params, root, origin, "ssg", basePath);
  if (renderResult instanceof Response) {
    return renderResult;
  }
  const result = renderResult;

  const entry: SsgCacheEntry = {
    cachedAt: Date.now(),
    html: result.html,
    ndjson: result.ndjson,
    status: result.status,
  };
  setSSGCache(resolvedPath, entry);
  autoInvalidateRegistry.registerLoaderTags(resolvedPath, route.tags);

  return entry;
}

/** Maximum number of concurrent `prerenderSSG` calls during SSG warm-up. */
const SSG_WARM_CONCURRENCY = 4;

/**
 * Pre-renders all SSG routes that declare `staticParams` and populates the
 * in-memory cache before the first real request arrives.
 */
export async function warmSSGCache(
  routes: ResolvedRoute[],
  root: RootLayout,
  origin: string
): Promise<void> {
  const targets = routes.filter((r) => r.mode === "ssg" && r.page.staticParams);
  const warmupLogger = createLogger({});
  warmupLogger.set({
    furin: {
      render: "ssg",
      action: "warmup",
      routes: targets.length,
    },
  });
  warmupLogger.emit();

  type StaticParamsResult =
    | { error: unknown; route: ResolvedRoute }
    | { paramSets: Record<string, string>[]; route: ResolvedRoute };

  const staticParamsResults: StaticParamsResult[] = await mapWithConcurrency(
    targets,
    SSG_WARM_CONCURRENCY,
    async (route) => {
      try {
        const paramSets = (await route.page.staticParams?.()) ?? [];
        return { route, paramSets };
      } catch (err) {
        return { error: err, route };
      }
    }
  );

  const tasks: Array<() => Promise<void>> = [];
  for (const result of staticParamsResults) {
    if ("error" in result) {
      const errorLogger = createLogger({});
      errorLogger.set({
        furin: {
          render: "ssg",
          action: "warmup_failed",
          route: result.route.pattern,
        },
      });
      errorLogger.error(
        result.error instanceof Error ? result.error : new Error(String(result.error))
      );
      errorLogger.emit();
      continue;
    }
    const { route, paramSets } = result;
    if (!Array.isArray(paramSets)) {
      const errorLogger = createLogger({});
      errorLogger.set({
        furin: {
          render: "ssg",
          action: "warmup_failed",
          route: route.pattern,
        },
      });
      errorLogger.error(
        new Error(`staticParams() for "${route.pattern}" returned a non-array value`)
      );
      errorLogger.emit();
      continue;
    }
    for (const params of paramSets) {
      tasks.push(async () => {
        try {
          await prerenderSSG(route, params, root, origin, undefined);
        } catch (err) {
          const errorLogger = createLogger({});
          errorLogger.set({
            furin: {
              render: "ssg",
              action: "prerender_failed",
              route: route.pattern,
            },
          });
          errorLogger.error(err instanceof Error ? err : new Error(String(err)));
          errorLogger.emit();
        }
      });
    }
  }

  if (tasks.length === 0) {
    return;
  }

  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(SSG_WARM_CONCURRENCY, tasks.length) }, async () => {
    while (queue.length > 0) {
      await queue.shift()?.();
    }
  });
  await Promise.all(workers);
}
