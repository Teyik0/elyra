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
  | { type: "error"; error: unknown; headers: Record<string, string> };

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

  for (const [key, value] of Object.entries(pageResult)) {
    if (key === "__isDeferred") {
      continue;
    }
    if (value instanceof Promise) {
      deferredPromises[key] = value;
    } else {
      syncData[key] = value;
    }
  }

  for (const [key, value] of Object.entries(routeChainData)) {
    syncData[key] = value;
  }

  return {
    syncData,
    deferredPromises: Object.keys(deferredPromises).length > 0 ? deferredPromises : undefined,
  };
}

// TODO: remove _rootLayout parameter in next refactor (unused; routeChain[0] is root layout)
export async function runLoaders(
  route: ResolvedRoute,
  ctx: Context,
  _rootLayout: RuntimeRoute
): Promise<LoaderResult> {
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
    // - Scalar fields + all route-chain data → syncData (injected into the HTML shell)
    //
    // Route-chain loaders (layouts) are never deferred in v1; their data always
    // lands in syncData. Only the page loader's own `defer()` fields are split.
    const pageResult = await pagePromise;
    if (isDeferred(pageResult)) {
      const routeOnlyResults = await Promise.all([...loaderMap.values()]);
      const routeMerged = Object.assign({}, ...routeOnlyResults) as Record<string, unknown>;
      const { syncData, deferredPromises } = splitDeferredResult(pageResult, routeMerged);
      return { type: "data", syncData, deferredPromises, headers };
    }

    // No defer() — all data is synchronous
    return { type: "data", syncData: merged, deferredPromises: undefined, headers };
  } catch (err) {
    if (isNotFoundError(err)) {
      const headers: Record<string, string> = {};
      Object.assign(headers, ctx.set.headers);
      return { type: "not-found", error: err, headers };
    }
    if (err instanceof Response) {
      return { type: "redirect", response: err };
    }
    const headers: Record<string, string> = {};
    Object.assign(headers, ctx.set.headers);
    return { type: "error", error: err, headers };
  }
}
