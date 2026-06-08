import { existsSync } from "node:fs";
import type { Context } from "elysia";
import type { RuntimePage, RuntimeRoute } from "../../client.ts";
import { collectRouteChainFromRoute, isFurinPage, isFurinRoute } from "../../shared/utils/index.ts";
import { autoInvalidateRegistry } from "../auto-invalidate/registry.ts";
import {
  type DevLoaderCacheEntry,
  getDevISRLoaderCache,
  getDevSSGLoaderCache,
  isDevLoaderCacheValid,
  setDevISRLoaderCache,
  setDevSSGLoaderCache,
} from "../cache/dev-loader.ts";
import { type CompileContext, getCompileContext } from "../internal.ts";
import { resolvePath } from "../render/assemble.ts";
import { type LoaderResult, renderSSR, runLoaders } from "../render/index.ts";
import { collectRouteTags, getSourceModuleCandidates, isModuleNotFoundError } from "./discovery.ts";
import { collectIntermediateLayoutDirs, resolveMode } from "./patterns.ts";
import type { ResolvedRoute, RootLayout } from "./types.ts";

type RouteModuleImport = (specifier: string) => Promise<Record<string, unknown>>;

function isResolvedRouteModuleCandidate(
  layoutPath: string,
  imported: Record<string, unknown>,
  ctx: CompileContext | null
): boolean {
  if (existsSync(layoutPath) || ctx?.modules[layoutPath]) {
    return true;
  }

  return Object.keys(imported).length > 0;
}

export async function importFreshRouteModuleCandidate(
  layoutPath: string,
  timestamp: number,
  resolveImport: RouteModuleImport,
  ctx: CompileContext | null
): Promise<Record<string, unknown> | undefined> {
  try {
    const imported = await resolveImport(`${layoutPath}?furin-server&t=${timestamp}`);
    if (!isResolvedRouteModuleCandidate(layoutPath, imported, ctx)) {
      return;
    }

    return imported;
  } catch (err) {
    // Distinguish "this layout file does not exist" (legitimate skip) from
    // "this layout file's transitive imports failed" (real bug to surface).
    // If the layoutPath itself is on disk or registered in the compile ctx,
    // a ModuleNotFoundError must come from a sub-import — re-throw it so
    // the developer sees the actual broken import instead of a silently
    // ignored layout chain.
    const layoutFileIsKnown = existsSync(layoutPath) || Boolean(ctx?.modules[layoutPath]);
    if (!layoutFileIsKnown && isModuleNotFoundError(err)) {
      return;
    }
    throw err;
  }
}

async function importFreshLayoutRouteModule(
  layoutDir: string,
  timestamp: number,
  resolveImport: RouteModuleImport,
  ctx: CompileContext | null
): Promise<Record<string, unknown> | undefined> {
  for (const layoutPath of getSourceModuleCandidates(layoutDir, "_route")) {
    const freshMod = await importFreshRouteModuleCandidate(
      layoutPath,
      timestamp,
      resolveImport,
      ctx
    );
    if (freshMod) {
      return freshMod;
    }
  }

  return;
}

function patchRouteEntryFromFreshModule(
  entry: RuntimeRoute | undefined,
  freshMod: Record<string, unknown>
): void {
  const freshRoute = freshMod.route ?? freshMod.default;
  if (!(entry && freshRoute && isFurinRoute(freshRoute))) {
    return;
  }

  entry.layout = freshRoute.layout;
  entry.loader = freshRoute.loader;
}

/**
 * Re-imports intermediate layout _route.tsx files with cache-busting so that
 * server-side renders reflect the latest code after an HMR edit.  Bun's ESM
 * cache keeps the original module alive, so we import via ?furin-server and
 * patch the layout/loader references on the existing route-chain objects.
 *
 * The optional `importFn` parameter exists only for unit testing. In production
 * it defaults to the real `import()`.
 */
export async function refreshLayoutChain(
  chain: RuntimeRoute[],
  pagePath: string,
  rootPath: string,
  importFn: ((specifier: string) => Promise<Record<string, unknown>>) | undefined
): Promise<void> {
  const resolveImport: RouteModuleImport =
    importFn ?? ((s: string) => import(s) as Promise<Record<string, unknown>>);
  const ctx = getCompileContext();
  const timestamp = Date.now();
  const layoutDirs = collectIntermediateLayoutDirs(pagePath, rootPath);

  // Track chainIdx independently rather than deriving it from layoutPaths
  // index. Directories without a _route module produce import errors that are
  // silently skipped, but those directories have no corresponding chain entry —
  // so we must only advance chainIdx for directories whose _route module actually
  // exists. A positional assumption (i = chainIdx - 1) drifts whenever
  // isModuleNotFoundError is swallowed for a gap directory.
  //
  // Imports are parallelised for speed; patching stays sequential so the
  // chainIdx-to-layoutDir positional mapping remains deterministic.
  const freshMods = await Promise.all(
    layoutDirs.map((layoutDir) =>
      importFreshLayoutRouteModule(layoutDir, timestamp, resolveImport, ctx)
    )
  );
  let chainIdx = 1; // chain[0] is the root
  for (const freshMod of freshMods) {
    if (chainIdx >= chain.length) {
      break;
    }
    if (!freshMod) {
      // No _route module in this directory — no chain entry to match, so
      // do NOT advance chainIdx. The next deeper layoutDir may correspond
      // to the current chainIdx.
      continue;
    }

    patchRouteEntryFromFreshModule(chain[chainIdx], freshMod);
    // An _route module exists at this depth — advance chainIdx regardless of
    // whether the export is currently a valid route (the chain entry was
    // populated by the initial import and should be revisited on the next
    // successful HMR cycle).
    chainIdx++;
  }
}

/**
 * Rebuilds a `ResolvedRoute` from freshly-imported `page` and `chain` so that
 * `mode` reflects the CURRENT contents of the page module — not the value
 * captured at scan time.
 *
 * In dev, `handleDevRequest` re-imports the page on every request to pick up
 * source edits via the `?furin-server&t=<ts>` cache-buster. Without this
 * function the spread `{ ...route, page, chain }` would carry over the stale
 * `route.mode` resolved at startup, so toggling `revalidate` or removing a
 * loader in source would not retake effect until a server restart.
 *
 * Only `mode` is recomputed: it is the only field DERIVED from page+chain.
 * Structural fields (`pattern`, `path`, `segmentBoundaries`, `error`,
 * `notFound`) are scan-time invariants in dev and are preserved as-is.
 */
export function rebuildDevRoute(
  base: ResolvedRoute,
  page: RuntimePage,
  chain: RuntimeRoute[]
): ResolvedRoute {
  return {
    ...base,
    page,
    routeChain: chain,
    mode: resolveMode(page, chain),
    tags: collectRouteTags(chain, page),
  };
}

/** @internal Handles a request in dev mode — re-imports the page fresh on every request. */
export async function handleDevRequest(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout
): Promise<unknown> {
  // Load the page via ?furin-server virtual namespace so it stays out of
  // --hot's file watcher, then hand off to renderSSR which runs loaders,
  // renders React to HTML, and injects __FURIN_DATA__.
  try {
    let currentRoot = root;
    const rootMod = (await import(`${root.path}?furin-server&t=${Date.now()}`)) as Record<
      string,
      unknown
    >;
    const rootExport = rootMod.route ?? rootMod.default;
    if (rootExport && isFurinRoute(rootExport) && rootExport.layout) {
      // Preserve the RootLayout-level convention fields (error, notFound,
      // errorPath, notFoundPath) populated by `scanRootLayout` from
      // `pages/error.tsx` and `pages/not-found.tsx`.  Replacing the whole
      // RootLayout with just `{ path, route }` would silently drop these
      // fallbacks — `route.error ?? root.error` would resolve to `undefined`
      // in dev after the first request, making custom 404/500 screens
      // disappear after a HMR refresh.
      currentRoot = { ...currentRoot, route: rootExport };
    }

    const pageMod = await import(`${route.path}?furin-server&t=${Date.now()}`);
    const page = pageMod.default;
    if (page && isFurinPage(page)) {
      const chain = collectRouteChainFromRoute(page._route as RuntimeRoute);
      await refreshLayoutChain(chain, route.path, root.path, undefined);

      // Patch chain[0] (the root) with the freshly-imported root's loader
      // and layout.  `refreshLayoutChain` deliberately starts at chainIdx=1
      // because the root is already loaded separately above; without this
      // patch, chain[0] points to whatever object `_route.parent` captured
      // at _route's first evaluation — a STALE reference if Bun --hot
      // re-evaluated root.tsx without propagating the re-evaluation to
      // _route.tsx (the standard ESM behaviour).  Mirroring the pattern
      // used by patchRouteEntryFromFreshModule.
      if (chain[0] && currentRoot.route) {
        chain[0].layout = currentRoot.route.layout;
        chain[0].loader = currentRoot.route.loader;
      }

      const refreshedRoute = rebuildDevRoute(route, page, chain);

      // Live ISR — the loader chain is short-circuited by the dev cache when
      // a fresh entry exists.  HTML re-assembles every time so the dev shell
      // chunk URL is always current.
      if (refreshedRoute.mode === "isr") {
        return renderDevISRWithLoaderCache(refreshedRoute, ctx, currentRoot);
      }

      // Live SSG — same trick as Live ISR, but the cache entry is forever-fresh
      // (revalidate: Infinity) so the loader runs ONCE per cache key until a
      // source file in its dependency chain changes.  This matches production
      // SSG semantics ("loader runs once") in dev, instead of re-running the
      // loader on every refresh — which would make expensive loaders (DB
      // queries, MDX parsing, sitemap reads) painful in dev.
      if (refreshedRoute.mode === "ssg") {
        return renderDevSSGWithLoaderCache(refreshedRoute, ctx, currentRoot);
      }

      return renderSSR(refreshedRoute, ctx, currentRoot, undefined);
    }
  } catch (err) {
    console.error(`[furin] Dev page load error for ${route.path}:`, err);
  }
  // Fallback: page couldn't load — return a clear error response rather than
  // delegating to renderSSR with an undefined page.
  return new Response(
    `<!doctype html><html><body><h1>Page load error</h1><p>Could not load ${route.path}. Check the server console for details.</p></body></html>`,
    { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

/**
 * @internal Dev "Live ISR" — caches loader output, not assembled HTML.  On a
 * fresh cache hit the loader chain is skipped; the React render still runs so
 * the response embeds the latest dev shell (chunk URL, HMR runtime, …).  On
 * miss, runs loaders normally and stores the merged data record.
 */
export async function renderDevISRWithLoaderCache(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout
): Promise<Response> {
  const cacheKey = `${root.path}:${resolvePath(route.pattern, ctx.params ?? {})}`;
  const cached = getDevISRLoaderCache(cacheKey);

  if (cached && isDevLoaderCacheValid(cached)) {
    const precomputed: LoaderResult = {
      type: "data",
      syncData: cached.loaderData,
      deferredPromises: undefined,
      headers: cached.headers,
    };
    return renderSSR(route, ctx, root, precomputed);
  }

  const result = await runLoaders(route, ctx);
  if (result.type === "data") {
    const revalidate = route.page._route.revalidate ?? 60;
    const entry: DevLoaderCacheEntry = {
      dependencies: computeRouteDependencies(route.path, root.path),
      generatedAt: Date.now(),
      headers: result.headers,
      loaderData: result.syncData,
      mode: "isr",
      revalidate,
    };
    setDevISRLoaderCache(cacheKey, entry);
    autoInvalidateRegistry.registerLoaderTags(
      resolvePath(route.pattern, ctx.params ?? {}),
      route.tags
    );
  }
  return renderSSR(route, ctx, root, result);
}

/**
 * @internal Dev "Live SSG" — same shape as `renderDevISRWithLoaderCache`, but
 * the cached entry is tagged forever-fresh (`revalidate: Infinity`) so it
 * survives indefinitely until source-aware invalidation drops it.  This makes
 * dev SSG behave like production SSG: the loader runs ONCE per cache key,
 * not on every refresh.
 */
export async function renderDevSSGWithLoaderCache(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout
): Promise<Response> {
  const cacheKey = `${root.path}:${resolvePath(route.pattern, ctx.params ?? {})}`;
  const cached = getDevSSGLoaderCache(cacheKey);

  if (cached && isDevLoaderCacheValid(cached)) {
    const precomputed: LoaderResult = {
      type: "data",
      syncData: cached.loaderData,
      deferredPromises: undefined,
      headers: cached.headers,
    };
    return renderSSR(route, ctx, root, precomputed);
  }

  const result = await runLoaders(route, ctx);
  if (result.type === "data") {
    const entry: DevLoaderCacheEntry = {
      dependencies: computeRouteDependencies(route.path, root.path),
      generatedAt: Date.now(),
      headers: result.headers,
      loaderData: result.syncData,
      mode: "ssg",
      // SSG entries are forever-fresh — only source-aware invalidation drops them.
      revalidate: Number.POSITIVE_INFINITY,
    };
    setDevSSGLoaderCache(cacheKey, entry);
    autoInvalidateRegistry.registerLoaderTags(
      resolvePath(route.pattern, ctx.params ?? {}),
      route.tags
    );
  }
  return renderSSR(route, ctx, root, result);
}

/**
 * @internal Lists every source file whose contents can affect the render
 * output for a given page: the page itself, every intermediate `_route.*`
 * between the page and the pages root, and `root.tsx`.
 *
 * Only paths that EXIST on disk are returned.  `isDevLoaderCacheValid` treats
 * a `statSync` throw as "invalid" (conservative on missing files), so listing
 * non-authored extension candidates here would force a permanent cache MISS
 * for every nested route — silently disabling the dev ISR/SSG cache for any
 * page in a subdirectory.  Renames and deletions of TRACKED deps are still
 * detected: the path that previously existed will then `statSync`-throw on
 * the next read and yield the same conservative miss.
 */
export function computeRouteDependencies(pagePath: string, rootPath: string): string[] {
  const deps = [pagePath, rootPath];
  for (const dir of collectIntermediateLayoutDirs(pagePath, rootPath)) {
    for (const candidate of getSourceModuleCandidates(dir, "_route")) {
      if (existsSync(candidate)) {
        deps.push(candidate);
      }
    }
  }
  return deps;
}
