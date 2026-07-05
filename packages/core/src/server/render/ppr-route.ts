import type { Context } from "elysia";
import { toCrossJSON } from "seroval";
import { isRscSource } from "../../rsc/shared.tsx";
import { parseDeferredNdjson } from "../../shared/deferred-ndjson.ts";
import { serializeRouteFrames } from "../../shared/route-frame.ts";
import type { SearchRouteMetadata } from "../../shared/search-params.ts";
import { autoInvalidateRegistry } from "../auto-invalidate/registry.ts";
import type { RevalidateType } from "../cache/route-cache.ts";
import type { ResolvedRoute, RootLayout } from "../router/index.ts";
import {
  buildDeferredResolution,
  buildDeferredScript,
  buildRouteFrameTemplate,
  buildSyncRuntimeScript,
  resolvePath,
  splitTemplate,
} from "./assemble.ts";
import { type LoaderResult, runPublicLoaders, runRequestLoaderData } from "./loaders.ts";
import { type PprCacheEntry, prerenderPpr, resumePpr } from "./ppr.ts";
import { safeJson } from "./shell.ts";
import { prepareRender, serializeLoaderDataNdjson } from "./ssr.ts";

interface CachedPprRoute {
  entry: PprCacheEntry;
  generatedAt: number;
  revalidate: number;
}

const pprRoutes = new Map<string, CachedPprRoute>();

function pendingRequestData(): Promise<object> {
  const pending = new Promise<object>(() => {
    /* React prerender postpones this explicit Suspense dependency. */
  });
  pending.catch(() => undefined);
  return pending;
}

async function buildPublicEntry(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  buildId: string,
  searchRoutes: SearchRouteMetadata[] | undefined
): Promise<CachedPprRoute> {
  const result = await runPublicLoaders(route, ctx);
  if (result.type !== "data") {
    throw result.type === "redirect" ? result.response : result.error;
  }
  const publicResult: Extract<LoaderResult, { type: "data" }> = {
    ...result,
    deferredPromises: { ...(result.deferredPromises ?? {}), requestData: pendingRequestData() },
  };
  const prepared = await prepareRender(
    route,
    ctx,
    root,
    undefined,
    false,
    publicResult,
    searchRoutes
  );
  if (prepared instanceof Response) {
    throw prepared;
  }
  const routePayload = await serializeLoaderDataNdjson(
    { ...result.syncData, __furinPublicHeaders: result.headers },
    undefined
  );
  const entry = await prerenderPpr(prepared.element, {
    abortAfterMs: 25,
    buildId,
    publicRouteStream: new TextEncoder().encode(routePayload),
    status: prepared.status,
  });
  return {
    entry,
    generatedAt: Date.now(),
    revalidate: route.page._route.revalidate ?? 60,
  };
}

async function readPublicResult(
  entry: PprCacheEntry
): Promise<Extract<LoaderResult, { type: "data" }>> {
  const parsed = await parseDeferredNdjson(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(entry.publicRouteStream);
        controller.close();
      },
    }),
    undefined
  );
  const { __furinPublicHeaders, ...syncData } = parsed.syncData;
  const headers =
    __furinPublicHeaders !== null && typeof __furinPublicHeaders === "object"
      ? (__furinPublicHeaders as { [key: string]: string })
      : {};
  return { type: "data", syncData, deferredPromises: undefined, headers };
}

function dataMarkup(data: { [key: string]: unknown }): string {
  return Object.values(data).some((value) => isRscSource(value))
    ? buildRouteFrameTemplate(serializeRouteFrames(data))
    : `<script id="__FURIN_DATA__" type="application/json">${safeJson(data)}</script>`;
}

export async function renderPprRoute(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  buildId: string,
  searchRoutes: SearchRouteMetadata[] | undefined
): Promise<Response> {
  const cacheKey = `${route.mode}:${resolvePath(route.pattern, ctx.params ?? {})}`;
  let cached = pprRoutes.get(cacheKey);
  if (cached === undefined) {
    cached = await buildPublicEntry(route, ctx, root, buildId, searchRoutes);
    pprRoutes.set(cacheKey, cached);
    autoInvalidateRegistry.registerLoaderTags(
      resolvePath(route.pattern, ctx.params ?? {}),
      route.tags
    );
  } else if (route.mode === "isr" && Date.now() - cached.generatedAt >= cached.revalidate * 1000) {
    buildPublicEntry(route, ctx, root, buildId, searchRoutes)
      .then((entry) => pprRoutes.set(cacheKey, entry))
      .catch(() => {
        /* Atomic ISR: retain the previous good public shell. */
      });
  }

  const requestData = runRequestLoaderData(route, ctx);
  if (requestData === undefined) {
    throw new Error("[furin] internal PPR invariant: requestLoader is missing");
  }
  const publicResult = await readPublicResult(cached.entry);
  const actualResult: Extract<LoaderResult, { type: "data" }> = {
    ...publicResult,
    deferredPromises: {
      requestData,
    },
  };
  const prepared = await prepareRender(
    route,
    ctx,
    root,
    undefined,
    false,
    actualResult,
    searchRoutes
  );
  if (prepared instanceof Response) {
    return prepared;
  }

  const { headPre, bodyPre, bodyPost } = splitTemplate(prepared.template);
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const shellPrefix = headPre + prepared.headData + buildDeferredScript(["requestData"]) + bodyPre;

  (async () => {
    await writer.write(encoder.encode(shellPrefix));
    await writer.write(cached.entry.shell);
    const resumed = await resumePpr(
      prepared.element,
      cached.entry.postponedState,
      ctx.request.signal
    );
    await writer.write(resumed);
    const privateData = await requestData;
    const runtime =
      buildSyncRuntimeScript() +
      dataMarkup(prepared.syncData) +
      buildDeferredResolution("requestData", toCrossJSON(privateData), "resolve");
    await writer.write(encoder.encode(runtime + bodyPost));
    await writer.close();
  })().catch((error) => writer.abort(error));

  return new Response(readable, {
    status: prepared.status,
    headers: {
      ...prepared.headers,
      "Cache-Control": "private, no-store",
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

export function clearPprRouteCache(): void {
  pprRoutes.clear();
}

export function invalidatePprRoute(path: string, type: RevalidateType): boolean {
  let deleted = false;
  for (const key of pprRoutes.keys()) {
    const routePath = key.slice(key.indexOf(":") + 1);
    const matches =
      type === "layout"
        ? routePath === path || routePath.startsWith(path.endsWith("/") ? path : `${path}/`)
        : routePath === path;
    if (matches) {
      deleted = pprRoutes.delete(key) || deleted;
    }
  }
  return deleted;
}
