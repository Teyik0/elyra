import { type AnyElysia, type Context, Elysia, t } from "elysia";
import { getSchemaValidator } from "elysia/schema";
import { toCrossJSON, toCrossJSONAsync } from "seroval";
import { computeErrorDigest } from "../../shared/digest.ts";
import type { SearchParamsInput, SearchRouteMetadata } from "../../shared/search-params.ts";
import { autoInvalidateRegistry } from "../auto-invalidate/registry.ts";
import { useLogger } from "../context-logger.ts";
import { resolvePath } from "../render/assemble.ts";
import {
  handleISR,
  prerenderSSG,
  renderSSR,
  runLoaders,
  serializeDeferredRejection,
} from "../render/index.ts";
import { extractTitle } from "../render/shell.ts";
import { IS_DEV } from "../runtime-env.ts";
import { handleDevRequest } from "./hmr.ts";
import { buildRouteMatcher } from "./patterns.ts";
import { parseDataEndpointPath, parseRouteQuery } from "./schemas.ts";
import type { ResolvedRoute, RootLayout } from "./types.ts";

type SyntheticDataContext = Omit<Context, "params" | "query"> & {
  params: Record<string, string>;
  query: SearchParamsInput;
};

/** @internal Handles a production SSG route — sets ETags, Cache-Control, and Cache-Tag. */
async function handleSSGRequest(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  buildId: string,
  searchRoutes: SearchRouteMetadata[] | undefined
): Promise<unknown> {
  const origin = new URL(ctx.request.url).origin;
  const entry = await prerenderSSG(route, ctx.params, root, origin, undefined, searchRoutes);

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
  return entry.html;
}

interface RoutePlugin {
  buildId: string | null;
  root: RootLayout;
  route: ResolvedRoute;
  searchRoutes?: SearchRouteMetadata[];
}
export function createRoutePlugin({ route, root, buildId, searchRoutes }: RoutePlugin): AnyElysia {
  const resolvedBuildId = buildId ?? "";
  const { pattern, routeChain } = route;
  const plugin = new Elysia();

  for (const routeNode of routeChain) {
    if (routeNode.params || routeNode.query) {
      plugin.guard({
        params: routeNode.params,
        query: routeNode.query,
      });
    }
  }

  return plugin.get(pattern, (ctx) => {
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

    if (route.mode === "ssg") {
      return handleSSGRequest(route, ctx, root, resolvedBuildId, searchRoutes);
    }

    if (route.mode === "isr") {
      ctx.set.headers["cache-tag"] = resolvePath(pattern, ctx.params ?? {});
      return handleISR(route, ctx, root, resolvedBuildId, searchRoutes);
    }

    return renderSSR(route, ctx, root, undefined, searchRoutes);
  });
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
function buildSyntheticContext(
  params: Record<string, string | undefined>,
  request: Request,
  headers: Record<string, string | undefined>,
  cookie: unknown,
  url: URL,
  pathname: string
): SyntheticDataContext {
  const syntheticRequest = new Request(new URL(pathname + url.search, request.url), {
    headers: request.headers,
  });
  const syntheticSet = { headers: {} as Record<string, string>, status: 200 as number };

  return {
    request: syntheticRequest,
    params: params as Record<string, string>,
    query: Object.fromEntries(url.searchParams),
    set: syntheticSet,
    headers,
    cookie,
    path: pathname,
    redirect: (location: string, status?: number) =>
      new Response(null, { status: status ?? 302, headers: { location } }),
    status: (code: number) => new Response(null, { status: code }),
  } as unknown as SyntheticDataContext;
}

function validateRouteChain(
  routeChain: ResolvedRoute["routeChain"],
  syntheticCtx: SyntheticDataContext,
  url: URL
): Response | undefined {
  for (const routeNode of routeChain) {
    if (routeNode.params) {
      const validator = getSchemaValidator(routeNode.params, { dynamic: true });
      if (validator) {
        const result = validator.safeParse(syntheticCtx.params);
        if (!result.success) {
          return Response.json(
            {
              errors: result.errors ?? result.error,
              message: "Invalid params",
              type: "validation",
            },
            { status: 422 }
          );
        }
      }
    }
    if (routeNode.query) {
      const parsedQuery = parseRouteQuery(url, routeNode.query);
      if (!parsedQuery.ok) {
        return Response.json(
          { errors: parsedQuery.errors, message: "Invalid query", type: "validation" },
          { status: 422 }
        );
      }
      Object.assign(syntheticCtx.query, parsedQuery.query);
    }
  }
}

async function buildDataResponse(
  result: Awaited<ReturnType<typeof runLoaders>>,
  syntheticCtx: SyntheticDataContext,
  pathname: string,
  matchedRoute: ResolvedRoute
): Promise<Response> {
  if (result.type === "data") {
    autoInvalidateRegistry.registerLoaderTags(pathname, matchedRoute.tags);
  }

  if (result.type === "redirect") {
    const redirectUrl = new URL(
      result.response.headers.get("location") ?? "/",
      syntheticCtx.request.url
    );
    const serialized = await toCrossJSONAsync({
      __furinRedirect: redirectUrl.pathname + redirectUrl.search,
    });
    return new Response(`${JSON.stringify(serialized)}\n`, {
      headers: { "content-type": "application/x-ndjson" },
    });
  }

  if (result.type === "not-found") {
    const serialized = await toCrossJSONAsync({
      __furinStatus: 404,
      __furinNotFound: { message: result.error.message, data: result.error.data },
    });
    return new Response(`${JSON.stringify(serialized)}\n`, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });
  }

  if (result.type === "error") {
    const digest = computeErrorDigest(result.error);
    const serialized = await toCrossJSONAsync({
      __furinError: {
        digest,
        message: result.message,
        status: result.status,
      },
    });
    return new Response(`${JSON.stringify(serialized)}\n`, {
      status: result.status,
      headers: { "content-type": "application/x-ndjson" },
    });
  }

  const syncDataWithTitle = withResolvedTitle(matchedRoute, result.syncData);

  if (result.deferredPromises) {
    return new Response(createDeferredNdjsonStream(syncDataWithTitle, result.deferredPromises), {
      headers: {
        ...result.headers,
        "content-type": "application/x-ndjson",
      },
    });
  }

  const serialized = await toCrossJSONAsync(syncDataWithTitle);
  return new Response(`${JSON.stringify(serialized)}\n`, {
    headers: {
      ...result.headers,
      "content-type": "application/x-ndjson",
    },
  });
}

export function createDataEndpoint(routes: ResolvedRoute[]): AnyElysia {
  const matchRoute = buildRouteMatcher(routes);

  return new Elysia().get(
    "/_furin/data",
    async ({ request, headers, cookie, status, query: { path } }) => {
      if (!path || typeof path !== "string") {
        return status("Bad Request", "Missing required query param: path");
      }

      const parsed = parseDataEndpointPath(path);
      if (!parsed) {
        return status("Bad Request", "Invalid path");
      }
      const { url, pathname } = parsed;

      const wideEventLog = useLogger();
      wideEventLog.set({ path });
      const matched = matchRoute(pathname);
      if (!matched) {
        return status("Not Found", "Route not found");
      }
      wideEventLog.set({ routePattern: matched.route.pattern });

      const syntheticCtx = buildSyntheticContext(
        matched.params,
        request,
        headers,
        cookie,
        url,
        pathname
      );
      const validationError = validateRouteChain(matched.route.routeChain, syntheticCtx, url);
      if (validationError) {
        return validationError;
      }

      const result = await runLoaders(matched.route, syntheticCtx as unknown as Context);
      return buildDataResponse(result, syntheticCtx, pathname, matched.route);
    },
    {
      query: t.Object({ path: t.Optional(t.String()) }),
    }
  );
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
  const head = route.page.head;
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
                `${JSON.stringify({ key, action: "resolve", value: toCrossJSON(value) })}\n`
              )
            );
          } catch (err) {
            const normalized = await serializeDeferredRejection(err);
            const value = toCrossJSON(normalized);
            controller.enqueue(enc.encode(`${JSON.stringify({ key, action: "reject", value })}\n`));
          }
        })
      );
      controller.close();
    },
  });
}
