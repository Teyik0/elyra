import { type AnyElysia, type Context, Elysia, t } from "elysia";
import type { AnySchema } from "elysia/types";
import { toCrossJSON, toCrossJSONAsync } from "seroval";
import { computeErrorDigest } from "../../shared/digest.ts";
import {
  containsRscSource,
  serializeRouteFrame,
  serializeRouteFrames,
  serializeRouteFrameValue,
} from "../../shared/route-frame.ts";
import type { SearchParamsInput, SearchRouteMetadata } from "../../shared/search-params.ts";
import { autoInvalidateRegistry } from "../auto-invalidate/registry.ts";
import { useLogger } from "../context-logger.ts";
import { injectSyncRuntimeScript, resolvePath } from "../render/assemble.ts";
import { handleISR } from "../render/isr.ts";
import {
  hasRequestLoader,
  type LoaderResult,
  runLoaders,
  serializeDeferredRejection,
} from "../render/loaders.ts";
import { renderPprRoute } from "../render/ppr-route.ts";
import { extractTitle } from "../render/shell.ts";
import { prerenderSSG } from "../render/ssg.ts";
import { renderSSR } from "../render/ssr.ts";
import { IS_DEV } from "../runtime-env.ts";
import { handleDevRequest } from "./hmr.ts";
import { buildRouteMatcher } from "./patterns.ts";
import { mergeRouteSchemas } from "./schema-merge.ts";
import { applySchemaDefaults, parseDataEndpointPath, parseRouteQuery } from "./schemas.ts";
import type { ResolvedRoute, RootLayout } from "./types.ts";

type SyntheticDataContext = Omit<Context, "params" | "query"> & {
  params: Record<string, string>;
  query: SearchParamsInput;
};

async function createLoaderDataResponse(
  result: LoaderResult,
  route: ResolvedRoute,
  requestUrl: string
): Promise<Response> {
  if (result.type === "redirect") {
    const redirectUrl = new URL(result.response.headers.get("location") ?? "/", requestUrl);
    const serialized = await toCrossJSONAsync({
      __furinRedirect: redirectUrl.pathname + redirectUrl.search,
    });
    return new Response(`${JSON.stringify(serialized)}\n`, {
      headers: { "content-type": "application/x-ndjson" },
    });
  }
  if (result.type === "not-found") {
    const serialized = await toCrossJSONAsync({
      __furinNotFound: { data: result.error.data, message: result.error.message },
      __furinStatus: 404,
    });
    return new Response(`${JSON.stringify(serialized)}\n`, {
      headers: { "content-type": "application/x-ndjson" },
      status: 200,
    });
  }
  if (result.type === "error") {
    const serialized = await toCrossJSONAsync({
      __furinError: {
        digest: computeErrorDigest(result.error),
        message: result.message,
        status: result.status,
      },
    });
    return new Response(`${JSON.stringify(serialized)}\n`, {
      headers: { "content-type": "application/x-ndjson" },
      status: result.status,
    });
  }

  const syncDataWithTitle = withResolvedTitle(route, result.syncData);
  if (result.deferredPromises !== undefined) {
    const hasRsc = containsRscSource(syncDataWithTitle);
    const body = hasRsc
      ? createRscDeferredFrameStream(syncDataWithTitle, result.deferredPromises)
      : createDeferredNdjsonStream(syncDataWithTitle, result.deferredPromises);
    return new Response(body, {
      headers: {
        ...result.headers,
        "content-type": hasRsc ? "application/x-furin-route" : "application/x-ndjson",
      },
    });
  }
  return new Response(serializeRouteFrames(syncDataWithTitle, undefined), {
    headers: {
      ...result.headers,
      "content-type": "application/x-furin-route",
    },
  });
}

/** @internal Handles a production SSG route — sets ETags, Cache-Control, and Cache-Tag. */
async function handleSSGRequest(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  buildId: string,
  searchRoutes: SearchRouteMetadata[] | undefined
): Promise<unknown> {
  const { origin } = new URL(ctx.request.url);
  const entry = await prerenderSSG(route, ctx.params ?? {}, root, origin, undefined, searchRoutes);

  // Loader issued a redirect — forward it directly to the client.
  if (entry instanceof Response) {
    return entry;
  }

  const resolvedPath = resolvePath(route.pattern, ctx.params ?? {});

  // ETag: "buildId:cachedAt" — unique per render cycle, changes after revalidatePath
  const etag = buildId ? `"${buildId}:${entry.cachedAt}"` : null;
  if (etag && ctx.request.headers.get("if-none-match") === etag) {
    ctx.set.status = 304;
    return;
  }

  ctx.set.headers["content-type"] = "text/html; charset=utf-8";
  // Browser: max-age=0 + must-revalidate → always validates via ETag (304 = free)
  // CDN:     s-maxage=31536000 → cache for 1 year, purge via revalidatePath + purger
  ctx.set.headers["cache-control"] = "public, max-age=0, must-revalidate, s-maxage=31536000";
  if (etag) {
    ctx.set.headers.etag = etag;
  }
  ctx.set.headers["cache-tag"] = resolvedPath;
  return injectSyncRuntimeScript(entry.html);
}

export function createRoutePlugin(
  route: ResolvedRoute,
  root: RootLayout,
  buildId?: string,
  searchRoutes?: SearchRouteMetadata[]
): AnyElysia {
  const resolvedBuildId = buildId ?? "";
  const { pattern, routeChain } = route;

  const allParams = mergeRouteSchemas(routeChain, "params");
  const allQuery = mergeRouteSchemas(routeChain, "query");

  // Guard and handler MUST live in the same Elysia scope so that validation
  // (including default-filling) applies to the route handler's ctx.query.
  const plugin = new Elysia();

  if (allParams || allQuery) {
    plugin.guard({
      params: allParams as AnySchema,
      query: allQuery as AnySchema,
    });
  }

  plugin.get(pattern, (ctx) => {
    // Dev mode: re-imports page + layouts on every request via the
    // ?furin-server cache-buster, then dispatches into one of:
    //   - renderDevISRWithLoaderCache  (mode === "isr")
    //   - renderDevSSGWithLoaderCache  (mode === "ssg")
    //   - renderSSR                    (otherwise)
    //
    // Only the LOADER OUTPUT is cached in dev — HTML is always re-assembled
    // fresh so the response always embeds the latest Bun client chunk URL.
    // This avoids the "infinite reload loop" footgun where a cached ISR/SSG
    // HTML response held an OLD chunk URL after Bun rebundled.  The dev
    // cache is invalidated source-aware via `isDevLoaderCacheValid`
    // (mtime-checked dependency walk on every read).
    if (IS_DEV) {
      return handleDevRequest(route, ctx, root, searchRoutes);
    }

    if ((route.mode === "ssg" || route.mode === "isr") && hasRequestLoader(route)) {
      return renderPprRoute(route, ctx, root, resolvedBuildId, searchRoutes);
    }

    if (route.mode === "ssg") {
      return handleSSGRequest(route, ctx, root, resolvedBuildId, searchRoutes);
    }

    if (route.mode === "isr") {
      ctx.set.headers["cache-tag"] = resolvePath(route.pattern, ctx.params ?? {});
      return handleISR(route, ctx, root, resolvedBuildId, searchRoutes);
    }

    return renderSSR(route, ctx, root, undefined, searchRoutes);
  });

  return plugin;
}

/**
 * Elysia plugin that handles `GET /_furin/data?path=<logicalHref>`.
 *
 * Returns an NDJSON stream (one-line, v1) produced by `toCrossJSONAsync`:
 *   Line 0 — CrossJSON serialisation of `{ ...syncData, ...deferredPromises }`
 *
 * The `deferredPromises` values are awaited by `toCrossJSONAsync` before
 * serialising, so the client receives all data resolved in one round-trip.
 * SPA navigation calls this endpoint via `parseDeferredNdjson` in
 * `router-provider.tsx`.
 *
 * Special fields emitted alongside data:
 *   - `__furinStatus: 404` — when the loader called `notFound()`
 *   - `__furinNotFound`    — not-found payload
 *   - `__furinRedirect`    — logical path after a server-side redirect
 */
export function createDataEndpoint(routes: ResolvedRoute[]): AnyElysia {
  const plugin = new Elysia();
  const matchRoute = buildRouteMatcher(routes);

  plugin.get(
    "/_furin/data",
    async (ctx) => {
      const rawPath = ctx.query.path;
      if (!rawPath || typeof rawPath !== "string") {
        return new Response("Missing required query param: path", { status: 400 });
      }

      const parsed = parseDataEndpointPath(rawPath);
      if (!parsed) {
        return new Response("Invalid path", { status: 400 });
      }
      const { url, pathname } = parsed;

      // Rewrite the request-scoped wide event so logs / drains report the
      // *logical* path the user navigated to (e.g. "/board/123/card/456")
      // instead of the technical "/_furin/data" transport URL. We set this
      // before the route-match check so 404s also surface the attempted path
      // — otherwise monitoring just sees "GET /_furin/data 404" with no clue.
      const wideEventLog = useLogger();
      wideEventLog.set({ path: rawPath });

      // Precompiled at plugin creation: route regexes are built once, sorted
      // most-specific first, then the hot path only executes regex matches.
      const matched = matchRoute(pathname);

      if (!matched) {
        return new Response("Route not found", { status: 404 });
      }

      // Now that we know the matched pattern, add it as a stable aggregation
      // key for drains (e.g. "p99 latency by route").
      wideEventLog.set({ routePattern: matched.route.pattern });

      // Build a synthetic Elysia-compatible context for the matched route.
      // Loaders receive request, params, query, set, headers, and cookie.
      // Build the synthetic URL from the parsed `pathname + search` only —
      // never from `rawPath` directly — so an attacker cannot smuggle a
      // foreign origin into `syntheticRequest.url`.
      const syntheticRequest = new Request(new URL(pathname + url.search, ctx.request.url));
      const syntheticSet = { headers: {} as Record<string, string>, status: 200 as number };
      const syntheticCtx: SyntheticDataContext = {
        cookie: ctx.cookie,
        headers: ctx.headers,
        params: matched.params,
        path: pathname,
        query: Object.fromEntries(url.searchParams),
        // Loader-emitted redirects flow through `runLoaders` → `result.type
        // === "redirect"` and are converted to NDJSON below. The Response we
        // return here only has to be detectable by that pipeline.
        redirect: (location: string, status?: number) =>
          new Response(null, { headers: { location }, status: status ?? 302 }),
        request: syntheticRequest,
        set: syntheticSet,
        // Synthetic `status` helper: numeric codes only. Callers that reach
        // this endpoint never dispatch a string-keyed status; rejecting them
        // is safer than coercing via `Number(code)` and silently producing
        // `NaN`.
        status: (code: number) => new Response(null, { status: code }),
      } as unknown as SyntheticDataContext;

      // Normalize params and query through the same merged schemas used by
      // createRoutePlugin so loaders see identical typed/defaulted inputs.
      const mergedParams = mergeRouteSchemas(matched.route.routeChain, "params");
      const mergedQuery = mergeRouteSchemas(matched.route.routeChain, "query");
      const parsedQuery = await parseRouteQuery(url, mergedQuery);
      if (!parsedQuery.ok) {
        return Response.json(
          { errors: parsedQuery.errors, message: "Invalid query", type: "validation" },
          { status: 422 }
        );
      }
      syntheticCtx.params = applySchemaDefaults(
        mergedParams as Record<string, unknown> | undefined,
        syntheticCtx.params as Record<string, unknown>
      ) as Record<string, string>;
      syntheticCtx.query = parsedQuery.query as SearchParamsInput;

      const result = await runLoaders(matched.route, syntheticCtx as unknown as Context);

      // Keep the auto-invalidate registry in sync with whatever path was just
      // served, so subsequent `revalidateTag(...)` calls (e.g. from a mutation
      // afterHandle) can still find this URL by tag. Without this, a SPA-only
      // navigation path (which never goes through the full-HTML render that
      // also registers tags) would silently fall off the registry — the first
      // mutation invalidates and unregisters via the cache `onDelete` hook,
      // the next SPA fetch re-loads but does not re-register, and from then
      // on `revalidateTag` finds no path to invalidate.
      if (result.type === "data") {
        autoInvalidateRegistry.registerLoaderTags(pathname, matched.route.tags);
      }

      return createLoaderDataResponse(result, matched.route, ctx.request.url);
    },
    {
      query: t.Object({ path: t.Optional(t.String()) }),
    }
  );

  return plugin;
}

function createRscDeferredFrameStream(
  syncData: Record<string, unknown>,
  deferredPromises: Record<string, Promise<unknown>>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        encoder.encode(serializeRouteFrames(syncData, Object.keys(deferredPromises)))
      );
      await Promise.all(
        Object.entries(deferredPromises).map(async ([key, promise], index) => {
          try {
            const { rscFrames, value } = serializeRouteFrameValue(await promise, `defer-${index}`);
            controller.enqueue(
              encoder.encode(
                serializeRouteFrame({
                  key,
                  type: "defer-resolve",
                  value,
                })
              )
            );
            if (rscFrames) {
              controller.enqueue(encoder.encode(rscFrames));
            }
          } catch (error) {
            controller.enqueue(
              encoder.encode(
                serializeRouteFrame({
                  key,
                  type: "defer-reject",
                  value: toCrossJSON(await serializeDeferredRejection(error)),
                })
              )
            );
          }
        })
      );
      controller.close();
    },
  });
}

/**
 * Runs the matched page's `head()` against the resolved sync data and, when it
 * yields a title, returns a copy of `syncData` carrying the reserved
 * `__furinTitle` field. `head()` never executes in the browser, so this is the
 * only channel through which SPA navigation can learn the new document title.
 *
 * Deferred fields are absent from `syncData` (they are still Promises), so a
 * `head()` that reads one sees `undefined` — titles should be derived from
 * synchronous loader data. A throwing `head()` is swallowed: a missing title
 * must never break the data response.
 */
function withResolvedTitle(
  route: ResolvedRoute,
  syncData: Record<string, unknown>
): Record<string, unknown> {
  const { head } = route.page;
  if (!head) {
    return syncData;
  }
  let title: string | undefined;
  try {
    title = extractTitle(head(syncData).meta);
  } catch {
    return syncData;
  }
  if (title === undefined) {
    return syncData;
  }
  return { ...syncData, __furinTitle: title };
}

function createDeferredNdjsonStream(
  syncData: Record<string, unknown>,
  deferredPromises: Record<string, Promise<unknown>>
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const entries = Object.entries(deferredPromises);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const initial = toCrossJSON({
        ...syncData,
        __furinDeferredKeys: entries.map(([key]) => key),
      });
      controller.enqueue(enc.encode(`${JSON.stringify(initial)}\n`));

      await Promise.all(
        entries.map(async ([key, promise]) => {
          try {
            const value = await promise;
            controller.enqueue(
              enc.encode(
                `${JSON.stringify({ action: "resolve", key, value: toCrossJSON(value) })}\n`
              )
            );
          } catch (err) {
            const normalized = await serializeDeferredRejection(err);
            const value = toCrossJSON(normalized);
            controller.enqueue(enc.encode(`${JSON.stringify({ action: "reject", key, value })}\n`));
          }
        })
      );
      controller.close();
    },
  });
}
