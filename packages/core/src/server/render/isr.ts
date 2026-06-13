import type { Context } from "elysia";
import { renderToReadableStream } from "react-dom/server";
import { isNotFoundError } from "../../shared/not-found.ts";
import type { SearchRouteMetadata } from "../../shared/search-params.ts";
import { autoInvalidateRegistry } from "../auto-invalidate/registry.ts";
import { deleteISRCache, getISRCache, setISRCache } from "../cache/isr.ts";
import type { ISRCacheEntry } from "../cache/isr-ssg.ts";
import { createLogger, useLogger } from "../context-logger.ts";
import type { ResolvedRoute, RootLayout } from "../router/index.ts";
import { assembleHTML, type LoaderContext, resolvePath, streamToString } from "./assemble.ts";
import {
  type PreparedRender,
  prepareRender,
  renderElementWithShellFallback,
  renderForPath,
} from "./ssr.ts";

/**
 * Builds the Cache-Control header value for an ISR response.
 */
function isrCacheControl(isFresh: boolean, revalidate: number): string {
  const sMaxAge = isFresh ? revalidate : 0;
  return `public, max-age=0, must-revalidate, s-maxage=${sMaxAge}, stale-while-revalidate=${revalidate}`;
}

/**
 * ETag for an ISR entry: `"buildId:generatedAt"`. Null when no build ID is
 * available (dev), which disables conditional requests for that response.
 */
function isrEtag(buildId: string | undefined, generatedAt: number): string | null {
  return buildId ? `"${buildId}:${generatedAt}"` : null;
}

/**
 * Serves a response from an existing ISR cache entry.
 * Handles stale-while-revalidate background refresh and ETag conditional requests.
 */
function serveISRCacheHit(
  cached: ISRCacheEntry,
  ctx: Context,
  route: ResolvedRoute,
  params: Record<string, string>,
  cacheKey: string,
  revalidate: number,
  root: RootLayout,
  buildId: string | undefined,
  searchRoutes?: SearchRouteMetadata[]
): string | undefined {
  const isFresh = Date.now() - cached.generatedAt < revalidate * 1000;

  if (!isFresh) {
    revalidateInBackground(route, params, cacheKey, revalidate, root, ctx, searchRoutes);
  }

  const etag = isrEtag(buildId, cached.generatedAt);
  if (etag && ctx.request.headers.get("if-none-match") === etag) {
    ctx.set.status = 304;
    ctx.set.headers.etag = etag;
    ctx.set.headers["cache-control"] = isrCacheControl(isFresh, revalidate);
    return;
  }

  ctx.set.headers["content-type"] = "text/html; charset=utf-8";
  ctx.set.headers["cache-control"] = isrCacheControl(isFresh, revalidate);
  if (etag) {
    ctx.set.headers.etag = etag;
  }

  useLogger().set({
    furin: { render: "isr", route: route.pattern, cache: isFresh ? "hit" : "stale" },
  });
  return cached.html;
}

/**
 * Handles the ISR non-200 render path: shell-recovery with fallback error
 * component, structured logging, and cache-control headers.
 */
async function renderISRNon200(
  prepared: PreparedRender,
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  errorDigest: string | undefined,
  renderStart: number,
  buildId: string | undefined
): Promise<string> {
  const { componentProps, element, headData, headers, template, status, notFoundError } = prepared;
  const fallbackProps: Record<string, unknown> = { ...componentProps };
  if (status === 404) {
    fallbackProps.__furinStatus = 404;
    if (notFoundError) {
      fallbackProps.__furinNotFound = notFoundError;
    }
  }

  const { stream: reactStream, shellError } = await renderElementWithShellFallback(
    element,
    route.error ?? root.error,
    prepared.ssrContext
  );
  let finalStatus = status;
  let finalDigest = errorDigest;
  if (shellError) {
    finalStatus = 500;
    finalDigest = shellError.digest;
    useLogger().set({
      furin: {
        render: "isr",
        route: route.pattern,
        cache: "miss",
        digest: finalDigest,
        phase: "shell",
      },
    });
    fallbackProps.__furinError = { digest: finalDigest, status: finalStatus };
    fallbackProps.__furinStatus = 500;
  }
  if (!fallbackProps.__furinError && errorDigest) {
    fallbackProps.__furinError = { digest: errorDigest, status };
  }

  await reactStream.allReady;
  const reactHtml = await streamToString(reactStream);
  const html = assembleHTML(template, headData, reactHtml, fallbackProps);
  const generatedAt = Date.now();

  const renderMs = generatedAt - renderStart;
  useLogger().set({
    furin: {
      render: "isr",
      route: route.pattern,
      cache: "miss",
      render_ms: renderMs,
      ...(finalDigest ? { digest: finalDigest } : {}),
      status: finalStatus,
    },
  });

  const etag = isrEtag(buildId, generatedAt);
  // Apply loader-set headers first so custom headers survive, then let the
  // ISR-critical headers win (the cache contract is framework-owned).
  for (const [key, value] of Object.entries(headers)) {
    ctx.set.headers[key] = value;
  }
  ctx.set.headers["content-type"] = "text/html; charset=utf-8";
  ctx.set.headers["cache-control"] = "no-store";
  if (etag) {
    ctx.set.headers.etag = etag;
  }
  ctx.set.status = finalStatus;
  return html;
}

export async function handleISR(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  buildId: string | undefined,
  searchRoutes?: SearchRouteMetadata[]
) {
  const revalidate = route.page._route.revalidate ?? 60;
  const params = ctx.params ?? {};
  const cacheKey = resolvePath(route.pattern, params);

  const cached = getISRCache(cacheKey);
  if (cached) {
    return serveISRCacheHit(
      cached,
      ctx,
      route,
      params,
      cacheKey,
      revalidate,
      root,
      buildId,
      searchRoutes
    );
  }

  const renderStart = Date.now();
  const prepared = await prepareRender(route, ctx, root, undefined, false, undefined, searchRoutes);

  if (prepared instanceof Response) {
    return prepared;
  }

  const { element, headData, headers, syncData, template, status, errorDigest } = prepared;

  if (status !== 200) {
    return renderISRNon200(prepared, route, ctx, root, errorDigest, renderStart, buildId);
  }

  const stream = await renderToReadableStream(element);
  await stream.allReady;
  const reactHtml = await streamToString(stream);
  const html = assembleHTML(template, headData, reactHtml, syncData);
  const generatedAt = Date.now();

  useLogger().set({
    furin: {
      render: "isr",
      route: route.pattern,
      cache: "miss",
      render_ms: generatedAt - renderStart,
    },
  });

  setISRCache(cacheKey, { html, generatedAt, revalidate });
  autoInvalidateRegistry.registerLoaderTags(cacheKey, route.tags);

  const etag = isrEtag(buildId, generatedAt);
  // Apply loader-set headers first so custom headers survive, then let the
  // ISR-critical headers win (the cache contract is framework-owned).
  for (const [key, value] of Object.entries(headers)) {
    ctx.set.headers[key] = value;
  }
  ctx.set.headers["content-type"] = "text/html; charset=utf-8";
  ctx.set.headers["cache-control"] = isrCacheControl(true, revalidate);
  if (etag) {
    ctx.set.headers.etag = etag;
  }
  return html;
}

/** Tracks in-flight ISR revalidations to prevent thundering herd. */
const pendingRevalidations = new Set<string>();

function revalidateInBackground(
  route: ResolvedRoute,
  params: Record<string, string>,
  cacheKey: string,
  revalidate: number,
  root: RootLayout,
  originalCtx: LoaderContext,
  searchRoutes?: SearchRouteMetadata[]
) {
  if (pendingRevalidations.has(cacheKey)) {
    const logger = createLogger({});
    logger.set({
      furin: {
        render: "isr",
        route: route.pattern,
        cache: "revalidation_skipped",
        reason: "already_in_flight",
      },
    });
    logger.emit();
    return;
  }
  pendingRevalidations.add(cacheKey);

  renderForPath(
    route,
    params,
    root,
    new URL(originalCtx.request.url).origin,
    "isr",
    undefined,
    searchRoutes
  )
    .then((result) => {
      if (result instanceof Response) {
        return;
      }
      // Only replace the cached entry with a healthy 200 render. The current
      // ISR cache stores HTML only, so caching non-200 output would serve it
      // back as a 200 on the next hit.
      if (result.status !== 200) {
        const logger = createLogger({});
        logger.set({
          furin: {
            render: "isr",
            route: route.pattern,
            cache: "revalidation_skipped",
            reason: "non_200_render",
            status: result.status,
          },
        });
        logger.emit();
        return;
      }
      setISRCache(cacheKey, {
        html: result.html,
        generatedAt: Date.now(),
        revalidate,
      });
    })
    .catch((err: unknown) => {
      const logger = createLogger({});
      if (isNotFoundError(err)) {
        deleteISRCache(cacheKey);
        logger.set({
          furin: {
            render: "isr",
            route: route.pattern,
            cache: "revalidation_invalidated",
            reason: "not_found",
          },
        });
        logger.emit();
        return;
      }
      logger.set({
        furin: {
          render: "isr",
          route: route.pattern,
          cache: "revalidation_failed",
        },
      });
      logger.error(err instanceof Error ? err : new Error(String(err)));
      logger.emit();
    })
    .finally(() => {
      pendingRevalidations.delete(cacheKey);
    });
}
