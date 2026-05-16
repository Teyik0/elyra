import type { Context } from "elysia";
import { isDeferred, type RuntimeRoute } from "../client";
import { useLogger } from "../context-logger.ts";
import { type FurinNotFoundError, isNotFoundError } from "../not-found.ts";
import type { ResolvedRoute } from "../router";

export type LoaderResult =
  | {
      type: "data";
      /**
       * Synchronous (JSON-serialisable) loader fields. Injected into the initial
       * HTML shell as `__FURIN_DATA__` / the deferred registry's `_data` object.
       */
      syncData: Record<string, unknown>;
      /**
       * Promise-valued fields from a `defer()` return. `undefined` when the page
       * loader did not call `defer()`. Streamed as late `<script>` resolution
       * chunks (SSR) or as NDJSON chunks via `/_furin/data` (SPA nav).
       */
      deferredPromises: Record<string, Promise<unknown>> | undefined;
      headers: Record<string, string>;
    }
  | { type: "redirect"; response: Response }
  | { type: "not-found"; error: FurinNotFoundError; headers: Record<string, string> }
  | {
      type: "error";
      /**
       * Original thrown value, kept for digest computation and server logging.
       * For thrown `Response` objects this is the Response instance whose body
       * has already been consumed by `runLoaders` (do NOT read it again).
       */
      error: unknown;
      /** HTTP status to return. Default 500; sourced from `Response.status` for thrown Response objects. */
      status: number;
      /**
       * Safe public message extracted at the loader boundary. For thrown
       * `Response` objects: response body or `statusText`. For thrown `Error`
       * / non-Error values: a generic "Something went wrong" string (the raw
       * error/message is never leaked here — `errorMessageOf` decides what to
       * surface from the original `error` value when an `error.tsx` fallback
       * exists).
       */
      message: string;
      headers: Record<string, string>;
    };

/**
 * Navigation redirect status codes — the exact set `ctx.redirect()` can emit.
 * Other 3xx codes (304 Not Modified, 305/306) are NOT navigation redirects and
 * must not be treated as one even when they carry a `Location` header.
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * `true` only for HTTP responses that are syntactically valid redirects:
 * a navigation redirect status code AND a `Location` header. A redirect status
 * without `Location` is invalid HTTP and almost always a developer mistake —
 * surfaced as an error so it's debuggable rather than silently redirecting to `/`.
 */
function isHttpRedirect(res: Response): boolean {
  return REDIRECT_STATUSES.has(res.status) && res.headers.has("location");
}

/**
 * Reads the body of a thrown `Response` exactly once. Returns the body text
 * if present, otherwise the response's `statusText`. The body is consumed
 * destructively — callers must NOT read `res.body` / `res.text()` again.
 */
async function readResponseMessage(res: Response): Promise<string> {
  if (res.body === null) {
    return res.statusText;
  }
  try {
    const body = await res.text();
    return body || res.statusText;
  } catch {
    return res.statusText;
  }
}

/**
 * Wraps the Elysia context so that any property NOT present on `ctx` is
 * returned as an individual `Promise<value>` resolved from the accumulated
 * parent data. Properties that ARE present on `ctx` (request, params, set, …)
 * are returned as-is.
 *
 * A per-prop cache ensures the same Promise instance is returned on repeated
 * access of the same field (stable reference for Promise.all etc.).
 */
function createLoaderCtx(
  ctx: Record<string, unknown>,
  accumulatedParentPromise: Promise<Record<string, unknown>>
): Record<string, unknown> {
  const cache = new Map<string, Promise<unknown>>();
  return new Proxy(ctx, {
    get(target, prop: string | symbol) {
      if (typeof prop !== "string") {
        return Reflect.get(target, prop);
      }
      // Short-circuit well-known Promise/serialisation introspection keys so
      // the proxy is never treated as a thenable by Promise.resolve() or
      // JSON.stringify(), which would cause silent infinite loops or wrong types.
      if (prop === "then" || prop === "catch" || prop === "finally" || prop === "toJSON") {
        return Reflect.get(target, prop);
      }
      // RouteContext fields (request, params, query, set, headers, cookie,
      // path, redirect) are present on target — return directly.
      // Use hasOwn so prototype keys (toString, constructor, …) are not
      // mistaken for context fields and incorrectly hide parent loader data.
      if (Object.hasOwn(target, prop)) {
        return target[prop];
      }
      // Everything else is a parent-data field → individual lazy Promise.
      let entry = cache.get(prop);
      if (!entry) {
        entry = accumulatedParentPromise.then((data) => data[prop]);
        cache.set(prop, entry);
      }
      return entry;
    },
  });
}

/**
 * Splits a `defer()` page result into sync scalars and deferred Promises,
 * then merges in the already-resolved route-chain loader data.
 */
function splitDeferredResult(
  pageResult: Record<string, unknown>,
  routeChainData: Record<string, unknown>
): {
  syncData: Record<string, unknown>;
  deferredPromises: Record<string, Promise<unknown>> | undefined;
} {
  const syncData: Record<string, unknown> = {};
  const deferredPromises: Record<string, Promise<unknown>> = {};

  // Route-chain data first so page sync fields can overwrite it — matching the
  // non-deferred Object.assign order where page result is spread last and wins.
  for (const [key, value] of Object.entries(routeChainData)) {
    syncData[key] = value;
  }

  for (const [key, value] of Object.entries(pageResult)) {
    if (key === "__isDeferred") {
      continue;
    }
    if (isPromiseLike(value)) {
      deferredPromises[key] = Promise.resolve(value);
    } else {
      syncData[key] = value;
    }
  }

  return {
    syncData,
    deferredPromises: Object.keys(deferredPromises).length > 0 ? deferredPromises : undefined,
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Normalises an error thrown inside a deferred Promise into a value that is
 * safe to send through `toCrossJSON` and that preserves the original semantics
 * after `fromCrossJSON` on the client.
 *
 * Symmetric to the rejection handling in `runLoaders` (lines 247-272) but for
 * the *deferred* path, where the rejection is delivered to a client-side
 * `<Await>` instead of becoming a top-level response.
 *
 *  - `notFound()`         → `Error` carrying `__furinBrand` + `data` so the
 *                            client-side `isNotFoundError()` (duck-typed)
 *                            recognises the rejection.
 *  - `Response(status, body)` → `Error` carrying `__furinStatus` and the
 *                            body/statusText as `message`.
 *  - `Error`              → returned unchanged.
 *  - anything else        → wrapped in `new Error(String(value))`.
 */
export async function serializeDeferredRejection(err: unknown): Promise<unknown> {
  if (isNotFoundError(err)) {
    const wrapped = new Error(err.message);
    Object.assign(wrapped, { __furinBrand: "FURIN_NOT_FOUND", data: err.data });
    return wrapped;
  }
  if (err instanceof Response) {
    const body = await readResponseMessage(err);
    const wrapped = new Error(body || err.statusText || "Something went wrong");
    Object.assign(wrapped, { __furinStatus: err.status });
    return wrapped;
  }
  if (err instanceof Error) {
    return err;
  }
  return new Error(String(err));
}

/**
 * v1 restriction: defer() is only valid in a page loader. Route/layout loaders
 * returning a deferred object would silently leak the brand into syncData and
 * pass raw Promises to descendants — fail fast at the loader boundary instead.
 */
function assertNoDeferredInRouteLoaders(routeResults: unknown[]): void {
  for (const result of routeResults) {
    if (isDeferred(result as Record<string, unknown>)) {
      throw new Error(
        "[furin] defer() is only supported in a page loader (route.page({ loader })). A route/layout loader returned a deferred object; move the deferred fields to the page loader, or `await` them in the route loader and return resolved values."
      );
    }
  }
}

export async function runLoaders(route: ResolvedRoute, ctx: Context): Promise<LoaderResult> {
  try {
    // Inject `log` so loaders can destructure it directly as `({ log })`.
    // useLogger() resolves the correct logger for every rendering context:
    // live request → evlog request-scoped logger, synthetic render → detached
    // createLogger() from runInSyntheticRenderScope, outside any context → no-op.
    const ctxRecord = { ...(ctx as Record<string, unknown>), log: useLogger() };
    const loaderMap = new Map<RuntimeRoute, Promise<Record<string, unknown>>>();

    // All loaders in the chain start immediately. Each receives a Proxy where
    // parent-data fields are individually-awaitable Promises. The loader opts
    // in to waiting by doing `await user` (or `Promise.all([user, org])`);
    // if it never awaits a parent field it runs in full parallel.
    let accumulatedParentPromise: Promise<Record<string, unknown>> = Promise.resolve({});

    for (const r of route.routeChain) {
      const parentAccum = accumulatedParentPromise; // capture for closure

      if (r.loader) {
        const loaderCtx = createLoaderCtx(ctxRecord, parentAccum);
        const loaderPromise = Promise.resolve(r.loader(loaderCtx)).then((res) => res ?? {});
        loaderMap.set(r, loaderPromise);

        // Accumulate: previous ancestors + this loader's result.
        // A void .catch() suppresses the "unhandled rejection" warning that
        // fires when a sibling or child loader throws — but unlike `.catch(
        // () => ({}))` it does NOT resolve the promise, so child loaders'
        // field-accesses via createLoaderCtx still receive the rejection
        // instead of silently resolving to undefined. The real rejection is
        // re-thrown by the Promise.all below.
        accumulatedParentPromise = Promise.all([parentAccum, loaderPromise]).then(([acc, own]) => ({
          ...acc,
          ...own,
        }));
        accumulatedParentPromise.catch(() => {
          /* suppress unhandled-rejection warning */
        });
      }
    }

    // Page loader receives all route-chain fields as individual Promises.
    const pageCtx = createLoaderCtx(ctxRecord, accumulatedParentPromise);
    const pagePromise: Promise<Record<string, unknown>> = route.page?.loader
      ? Promise.resolve(route.page.loader(pageCtx)).then((r) => r ?? {})
      : Promise.resolve({});

    // Await everything in parallel, then flat-merge.
    const results = await Promise.all([...loaderMap.values(), pagePromise]);
    const merged = Object.assign({}, ...results);
    const headers: Record<string, string> = {};
    Object.assign(headers, ctx.set.headers);

    // When the page loader returned a `defer()` object, split its fields:
    // - Promise-valued fields → deferredPromises (streamed lazily)
    // - Scalar fields + all route-chain loader data → syncData (injected into the HTML shell)
    //
    // Route-chain loaders (layouts) are never deferred in v1; their data always
    // lands in syncData. Only the page loader's own `defer()` fields are split.
    const routeOnlyResults = results.slice(0, loaderMap.size);
    const pageResult = results[loaderMap.size] as Record<string, unknown>;

    assertNoDeferredInRouteLoaders(routeOnlyResults);
    // Route context is always injected into syncData so components receive
    // params, query and path regardless of the serialisation path (SSR, SPA
    // nav, dev cache).
    const routeCtx = { params: ctx.params, query: ctx.query, path: ctx.path };
    if (isDeferred(pageResult)) {
      const routeMerged = Object.assign({}, ...routeOnlyResults) as Record<string, unknown>;
      const { syncData, deferredPromises } = splitDeferredResult(pageResult, routeMerged);
      return { type: "data", syncData: { ...syncData, ...routeCtx }, deferredPromises, headers };
    }

    // No defer() — all data is synchronous
    return {
      type: "data",
      syncData: { ...merged, ...routeCtx },
      deferredPromises: undefined,
      headers,
    };
  } catch (err) {
    const headers: Record<string, string> = {};
    Object.assign(headers, ctx.set.headers);
    if (isNotFoundError(err)) {
      return { type: "not-found", error: err, headers };
    }
    if (err instanceof Response) {
      if (isHttpRedirect(err)) {
        return { type: "redirect", response: err };
      }
      // Non-redirect Response → error. Read the body ONCE here so downstream
      // consumers (digest, logging, error UI) all share the same extracted
      // message without consuming the stream a second time.
      //
      // 3xx without Location is invalid HTTP — treat as a developer mistake
      // (status 500) rather than honouring an unreachable redirect status.
      const isMalformedRedirect = err.status >= 300 && err.status < 400;
      const status = isMalformedRedirect ? 500 : err.status;
      const body = await readResponseMessage(err);
      const message = body || "Something went wrong";
      return { type: "error", error: err, status, message, headers };
    }
    return {
      type: "error",
      error: err,
      status: 500,
      message: "Something went wrong",
      headers,
    };
  }
}
