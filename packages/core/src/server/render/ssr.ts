// biome-ignore-all lint/correctness/useHookAtTopLevel: useLogger is not a hook attached to a react component

import type { Context } from "elysia";
import { createElement, type ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import { toCrossJSON, toCrossJSONAsync } from "seroval";
import {
  normalizeHref,
  RouterContext,
  type RouterContextValue,
} from "../../client/router/index.ts";
import { computeErrorDigest } from "../../shared/digest.ts";
import { runInSyntheticRenderScope, useLogger } from "../context-logger.ts";
// FurinNotFoundError is used indirectly via buildNotFoundElement in element.tsx
import type { ResolvedRoute, RootLayout } from "../router/index.ts";
import { IS_DEV } from "../runtime-env.ts";
import {
  assembleHTML,
  buildDeferredResolution,
  buildDeferredScript,
  resolvePath,
  splitTemplate,
  streamToString,
} from "./assemble.ts";
import { buildElement, buildErrorElement, buildNotFoundElement } from "./element.tsx";
import { type LoaderResult, runLoaders, serializeDeferredRejection } from "./loaders.ts";
import { buildHeadInjection, generateIndexHtml, safeJson } from "./shell.ts";
import { getDevTemplate, getProductionTemplate } from "./template.ts";

// Re-export types consumed by sibling render modules (not a public barrel).
export type { LoaderContext } from "./assemble.ts";
export type { LoaderResult } from "./loaders.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RenderResult {
  headers: Record<string, string>;
  html: string;
  /**
   * NDJSON payload (one CrossJSON-serialised line) carrying the loader's
   * resolved sync + deferred data. Identical in shape to the body the live
   * `/_furin/data` endpoint emits, so the SPA client can consume both
   * interchangeably.
   */
  ndjson: string;
  status: number;
}

export interface PreparedRender {
  /**
   * All props passed to the React component tree. For deferred renders this
   * includes the Promise objects (for `<Await resolve={promise}>`) alongside
   * the scalar sync fields. Never serialise this directly — use `syncData`.
   */
  componentProps: Record<string, unknown>;
  /**
   * Promise-valued fields from a `defer()` loader return. Undefined for normal
   * (non-deferred) loaders. These are streamed as late `<script>` chunks after
   * the React stream finishes.
   */
  deferredPromises: Record<string, Promise<unknown>> | undefined;
  element: ReactNode;
  /** Set when the prepared element is an error UI. */
  errorDigest?: string;
  headData: string;
  headers: Record<string, string>;
  loader_ms: number;
  /**
   * Populated only when the loader threw `notFound()`. Mirrored into
   * `__FURIN_DATA__.__furinNotFound` so the client-side can render the
   * not-found UI inline on SPA navigation.
   */
  notFoundError?: { data?: unknown; message?: string };
  ssrContext: RouterContextValue;
  status: number;
  /**
   * JSON-serialisable subset of `componentProps`. For deferred renders this
   * excludes the Promise fields (those are streamed separately).
   */
  syncData: Record<string, unknown>;
  template: string;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

export function withSSRRouterContext(
  element: ReactNode,
  contextValue: RouterContextValue
): ReactNode {
  return createElement(RouterContext.Provider, { value: contextValue }, element);
}

interface ShellFallbackResult {
  /**
   * Set when the primary element threw synchronously during render and a
   * fallback error UI was streamed instead. Carries the digest so the caller
   * can surface it in logs and the `__furinError` payload.
   */
  shellError: { digest: string } | undefined;
  stream: Awaited<ReturnType<typeof renderToReadableStream>>;
}

/**
 * Renders `element` to a React stream, recovering from a synchronous shell
 * throw with a 500 error UI. The supplied error component (route-level, else
 * root-level) is tried first; if it ALSO throws, the built-in error element is
 * used, so a broken custom error page can never take down the whole response.
 *
 * Shared by SSR (which pipes the stream) and ISR/SSG non-200 (which drains it
 * to a string) — both start from this same React stream and only diverge in how
 * they consume it and which fields they log.
 */
export async function renderElementWithShellFallback(
  element: ReactNode,
  errorComponent: Parameters<typeof buildErrorElement>[0],
  ssrContext: RouterContextValue
): Promise<ShellFallbackResult> {
  try {
    return { stream: await renderToReadableStream(element), shellError: undefined };
  } catch (error) {
    const digest = computeErrorDigest(error);
    try {
      const stream = await renderToReadableStream(
        withSSRRouterContext(
          buildErrorElement(errorComponent, error, digest, undefined, 500),
          ssrContext
        )
      );
      return { stream, shellError: { digest } };
    } catch {
      const stream = await renderToReadableStream(
        withSSRRouterContext(
          buildErrorElement(undefined, error, digest, undefined, 500),
          ssrContext
        )
      );
      return { stream, shellError: { digest } };
    }
  }
}

/**
 * defer() streams data progressively — it only makes sense in SSR. In SSG/ISR
 * the HTML is pre-rendered and cached, so the deferred fields would be absent
 * from the embedded `__FURIN_DATA__` and the client `<Await>` would hydrate
 * with `undefined`. Fail fast at the loader boundary.
 */
export function assertDeferredModeAllowed(
  route: ResolvedRoute,
  deferredPromises: Record<string, Promise<unknown>> | undefined
): void {
  if (deferredPromises !== undefined && route.mode !== "ssr") {
    throw new Error(
      `[furin] page "${route.pattern}" returned defer() but the route is rendered in "${route.mode}" mode. ` +
        "defer() streams data progressively and is only supported in SSR. " +
        "Return the data directly (await it inside the loader) or switch the route to SSR mode."
    );
  }
}

/**
 * Builds the success-path element and head injection. `head()` is user code
 * that runs synchronously, outside the render pipeline's shell-error handling,
 * so a throw is converted into a 500 error render that surfaces through the
 * framework error UI instead of escaping `prepareRender` and crashing the
 * request. Re-throws when `throwOnFailure` is set (build-time SSG) so CI fails
 * loudly.
 */
function buildSuccessRender(
  route: ResolvedRoute,
  root: RootLayout,
  componentProps: Record<string, unknown>,
  throwOnFailure: boolean
): { element: ReactNode; headData: string; errorDigest: string | undefined; status: number } {
  try {
    const headData = buildHeadInjection(route.page?.head?.(componentProps));
    const element = buildElement(route, componentProps, root.route);
    return { element, headData, errorDigest: undefined, status: 200 };
  } catch (headError) {
    if (throwOnFailure) {
      throw headError;
    }
    const errorDigest = computeErrorDigest(headError);
    const element = buildErrorElement(
      route.error ?? root.error,
      headError,
      errorDigest,
      undefined,
      500
    );
    return { element, headData: "", errorDigest, status: 500 };
  }
}

/**
 * Shared pipeline steps used by both `renderToHTML` (buffered) and `renderSSR`
 * (streaming). Runs loaders, builds props, head injection, resolves template,
 * and creates the React element.
 *
 * Returns the redirect Response directly when a loader redirects, so callers
 * never need try/catch for redirect handling.
 */
export async function prepareRender(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  basePath: string | undefined,
  throwOnFailure: boolean,
  precomputedLoaderResult: LoaderResult | undefined
): Promise<PreparedRender | Response> {
  const loaderStart = Date.now();
  const loaderResult = precomputedLoaderResult ?? (await runLoaders(route, ctx));
  const loader_ms = Date.now() - loaderStart;

  if (loaderResult.type === "redirect") {
    return loaderResult.response;
  }

  // Build-time paths (SSG) opt into re-throwing so CI fails loudly instead of
  // silently generating a 404/500 page for buggy loaders.
  if (throwOnFailure && (loaderResult.type === "not-found" || loaderResult.type === "error")) {
    throw loaderResult.error;
  }

  const isNotFound = loaderResult.type === "not-found";
  const isError = loaderResult.type === "error";
  const isFallback = isNotFound || isError;
  const syncData = isFallback ? {} : loaderResult.syncData;
  const deferredPromises =
    !isFallback && loaderResult.type === "data" ? loaderResult.deferredPromises : undefined;
  assertDeferredModeAllowed(route, deferredPromises);

  const headers = loaderResult.headers;
  const componentProps = {
    ...syncData,
    ...(deferredPromises ?? {}),
    params: ctx.params,
    query: ctx.query,
    path: ctx.path,
  };

  const prodTemplate = getProductionTemplate();
  const template =
    prodTemplate ??
    (IS_DEV ? await getDevTemplate(new URL(ctx.request.url).origin) : generateIndexHtml());

  let element: ReactNode;
  let headData = "";
  let status = 200;
  let errorDigest: string | undefined;
  let notFoundError: { data?: unknown; message?: string } | undefined;
  if (loaderResult.type === "not-found") {
    element = buildNotFoundElement(route.notFound ?? root.notFound, loaderResult.error);
    status = 404;
    notFoundError = { message: loaderResult.error.message, data: loaderResult.error.data };
  } else if (loaderResult.type === "error") {
    errorDigest = computeErrorDigest(loaderResult.error);
    element = buildErrorElement(
      route.error ?? root.error,
      loaderResult.error,
      errorDigest,
      loaderResult.message,
      loaderResult.status
    );
    status = loaderResult.status;
  } else {
    const success = buildSuccessRender(route, root, componentProps, throwOnFailure);
    element = success.element;
    headData = success.headData;
    errorDigest = success.errorDigest;
    status = success.status;
  }

  const ssrContext: RouterContextValue = {
    basePath: basePath ?? "",
    currentHref: normalizeHref(ctx.path),
    navigate: () => Promise.resolve(),
    prefetch: () => {
      /* noop */
    },
    invalidatePrefetch: () => {
      /* noop */
    },
    refresh: () => Promise.resolve(),
    isNavigating: false,
    defaultPreload: "intent",
    defaultPreloadDelay: 50,
    defaultPreloadStaleTime: 30_000,
  };
  element = withSSRRouterContext(element, ssrContext);

  return {
    componentProps,
    deferredPromises,
    element,
    errorDigest,
    headData,
    headers,
    loader_ms,
    notFoundError,
    syncData,
    ssrContext,
    status,
    template,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function renderForPath(
  route: ResolvedRoute,
  params: Record<string, string>,
  root: RootLayout,
  origin: string,
  mode: "ssg" | "isr",
  basePath: string | undefined
): Promise<RenderResult | Response> {
  return runInSyntheticRenderScope(
    async () => {
      const resolvedPath = resolvePath(route.pattern, params);
      const ctx: Context = {
        params,
        query: {},
        request: new Request(`${origin}${resolvedPath}`),
        headers: {},
        cookie: {},
        redirect: (url: string, status: number | undefined) =>
          new Response(null, { status: status ?? 302, headers: { Location: url } }),
        set: { headers: {} },
        path: resolvedPath,
      } as Context;

      const prepared = await prepareRender(route, ctx, root, basePath, true, undefined);
      if (prepared instanceof Response) {
        return prepared;
      }

      useLogger().set({
        furin: {
          render: mode,
          route: route.pattern,
          cache: mode === "isr" ? "revalidated" : "miss",
          loader_ms: prepared.loader_ms,
          ...(prepared.errorDigest ? { digest: prepared.errorDigest } : {}),
        },
      });

      const { deferredPromises, element, headData, headers, status, syncData, template } = prepared;
      const stream = await renderToReadableStream(element);
      await stream.allReady;
      const reactHtml = await streamToString(stream);
      return {
        html: assembleHTML(template, headData, reactHtml, syncData),
        headers,
        ndjson: await serializeLoaderDataNdjson(syncData, deferredPromises),
        status,
      };
    },
    { route: route.pattern, render: mode }
  );
}

/**
 * Serialises a loader's `syncData` + `deferredPromises` into the same one-line
 * NDJSON shape the live `/_furin/data` endpoint emits.
 */
export async function serializeLoaderDataNdjson(
  syncData: Record<string, unknown>,
  deferredPromises: Record<string, Promise<unknown>> | undefined
): Promise<string> {
  const payload: Record<string, unknown> = {
    ...syncData,
    ...(deferredPromises ?? {}),
  };
  const serialized = await toCrossJSONAsync(payload);
  return `${JSON.stringify(serialized)}\n`;
}

// ── Core pipeline ────────────────────────────────────────────────────────────

export async function renderToHTML(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout
): Promise<RenderResult> {
  const prepared = await prepareRender(route, ctx, root, undefined, false, undefined);

  if (prepared instanceof Response) {
    throw prepared;
  }

  const { deferredPromises, element, headData, headers, status, syncData, template } = prepared;

  const stream = await renderToReadableStream(element);
  await stream.allReady;
  const reactHtml = await streamToString(stream);

  return {
    html: assembleHTML(template, headData, reactHtml, syncData),
    headers,
    ndjson: await serializeLoaderDataNdjson(syncData, deferredPromises),
    status,
  };
}

export async function renderToStream(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout
): Promise<ReadableStream | Response> {
  const response = await renderSSR(route, ctx, root, undefined);
  if (!response.ok) {
    return response;
  }
  return response.body ?? new ReadableStream();
}

export async function renderSSR(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  precomputedLoaderResult: LoaderResult | undefined
): Promise<Response> {
  const prepared = await prepareRender(route, ctx, root, undefined, false, precomputedLoaderResult);

  if (prepared instanceof Response) {
    return prepared;
  }

  useLogger().set({
    furin: {
      render: route.mode,
      route: route.pattern,
      loader_ms: prepared.loader_ms,
      ...(prepared.errorDigest ? { digest: prepared.errorDigest } : {}),
    },
  });

  const { deferredPromises, element, headData, headers, syncData, template } = prepared;

  const { headPre, bodyPre, bodyPost } = splitTemplate(template);

  const { stream: reactStream, shellError } = await renderElementWithShellFallback(
    element,
    route.error ?? root.error,
    prepared.ssrContext
  );
  const shellErrored = shellError !== undefined;
  let status = prepared.status;
  let finalDigest = prepared.errorDigest;
  if (shellError) {
    status = 500;
    finalDigest = shellError.digest;
    useLogger().set({
      furin: { render: route.mode, route: route.pattern, digest: finalDigest, phase: "shell" },
    });
  }

  const dataPayload: Record<string, unknown> = shellErrored ? {} : { ...syncData };
  if (finalDigest) {
    dataPayload.__furinError = { digest: finalDigest, status };
  }
  if (status === 404 && !shellErrored) {
    dataPayload.__furinStatus = 404;
    if (prepared.notFoundError) {
      dataPayload.__furinNotFound = prepared.notFoundError;
    }
  }
  if (
    process.env.NODE_ENV !== "production" &&
    dataPayload.__furinError !== undefined &&
    dataPayload.__furinNotFound !== undefined
  ) {
    throw new Error(
      "[furin] internal invariant violated: __furinError and __furinNotFound were both set on the same SSR payload."
    );
  }

  const hasDeferred = !shellErrored && deferredPromises !== undefined;

  const deferredKeys = hasDeferred ? Object.keys(deferredPromises) : [];
  const deferredSetupScript = hasDeferred ? buildDeferredScript(deferredKeys) : "";

  const dataScript = `<script id="__FURIN_DATA__" type="application/json">${safeJson(
    dataPayload
  )}</script>`;

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  (async () => {
    await writer.write(enc.encode(headPre + headData + deferredSetupScript + bodyPre));

    const reader = reactStream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      await writer.write(value);
    }

    const [earlyBodyPost, finalBodyPost] = hasDeferred
      ? splitBeforeBodyClose(bodyPost)
      : ["", bodyPost];
    await writer.write(enc.encode(dataScript + earlyBodyPost));

    if (hasDeferred) {
      await Promise.all(
        Object.entries(deferredPromises).map(async ([key, promise]) => {
          try {
            const resolvedValue = await promise;
            const chunk = toCrossJSON(resolvedValue);
            await writer.write(enc.encode(buildDeferredResolution(key, chunk, "resolve")));
          } catch (err) {
            const normalized = await serializeDeferredRejection(err);
            const chunk = toCrossJSON(normalized);
            await writer.write(enc.encode(buildDeferredResolution(key, chunk, "reject")));
          }
        })
      );
    }

    await writer.write(enc.encode(finalBodyPost));
    await writer.close();
  })().catch((err) => writer.abort(err));

  return new Response(readable, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      ...headers,
    },
  });
}

export function splitBeforeBodyClose(bodyPost: string): [string, string] {
  const index = bodyPost.toLowerCase().lastIndexOf("</body>");
  if (index === -1) {
    return [bodyPost, ""];
  }
  return [bodyPost.slice(0, index), bodyPost.slice(index)];
}
