import type { Context } from "elysia";
import { renderToReadableStream } from "react-dom/server";
import { autoInvalidateRegistry } from "../auto-invalidate/registry.ts";
import { getISRCache, setISRCache } from "../cache/isr.ts";
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
  buildId: string | undefined
): string | undefined {
  const isFresh = Date.now() - cached.generatedAt < revalidate * 1000;

  if (!isFresh) {
    revalidateInBackground(route, params, cacheKey, revalidate, root, ctx);
  }

  const etag = buildId ? `"${buildId}:${cached.generatedAt}"` : null;
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

  const etag = buildId ? `"${buildId}:${generatedAt}"` : null;
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
  buildId: string | undefined
) {
  const revalidate = route.page._route.revalidate ?? 60;
  const params = ctx.params ?? {};
  const cacheKey = resolvePath(route.pattern, params);

  const cached = getISRCache(cacheKey);
  if (cached) {
    return serveISRCacheHit(cached, ctx, route, params, cacheKey, revalidate, root, buildId);
  }

  const renderStart = Date.now();
  const prepared = await prepareRender(route, ctx, root, undefined, false, undefined);

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

  const etag = buildId ? `"${buildId}:${generatedAt}"` : null;
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
  originalCtx: LoaderContext
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

  renderForPath(route, params, root, new URL(originalCtx.request.url).origin, "isr", undefined)
    .then((result) => {
      if (result instanceof Response) {
        return;
      }
      // Only replace the cached entry with a healthy 200 render. A background
      // revalidation that produced a fallback/error page must NOT overwrite the
      // still-serving good entry — the next request would otherwise be handed a
      // cached error page until the route is invalidated.
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
