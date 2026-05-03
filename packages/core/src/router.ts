import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, parse } from "node:path";
import { type AnyElysia, type Context, Elysia, t } from "elysia";
import type { AnySchema } from "elysia/types";
import { toCrossJSONAsync } from "seroval";
import type { RuntimePage, RuntimeRoute } from "./client.ts";
import type { ErrorComponent } from "./error.ts";
import { type CompileContext, getCompileContext } from "./internal.ts";
import type { NotFoundComponent } from "./not-found.ts";
import { resolvePath } from "./render/assemble.ts";
import {
  type DevLoaderCacheEntry,
  getDevISRLoaderCache,
  getDevSSGLoaderCache,
  isDevLoaderCacheValid,
  setDevISRLoaderCache,
  setDevSSGLoaderCache,
} from "./render/dev-cache.ts";
import {
  handleISR,
  type LoaderResult,
  prerenderSSG,
  renderSSR,
  runLoaders,
} from "./render/index.ts";
import { IS_DEV } from "./runtime-env.ts";
import {
  collectRouteChainFromRoute,
  isFurinPage,
  isFurinRoute,
  validateRouteChain,
} from "./utils.ts";

function isModuleNotFoundError(err: unknown): boolean {
  if (!err || (typeof err !== "object" && typeof err !== "string")) {
    return false;
  }
  const msg =
    typeof err === "string"
      ? err.toLowerCase()
      : String((err as { message?: unknown }).message ?? "").toLowerCase();
  const code = typeof err === "string" ? undefined : (err as { code?: string }).code;
  return (
    code === "ENOENT" ||
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODULE_NOT_FOUND" ||
    msg.includes("cannot find module") ||
    msg.includes("module not found") ||
    msg.includes("no such file or directory")
  );
}

/**
 * A single directory-scoped boundary declaration.
 *
 * Each entry represents ONE directory on the path from `pagesDir` to the page
 * file. `error` / `notFound` hold the components defined IN THAT DIRECTORY
 * only — never inherited from a parent. This 1:1 tie between directory and
 * entry is what lets the render layer insert React error boundaries at the
 * exact nesting level where the user authored them (Next.js app-router model).
 */
export interface SegmentBoundary {
  /** 0 = `pagesDir`; increments with each nested subdirectory. */
  depth: number;
  error?: ErrorComponent;
  /**
   * Absolute path to the `error.tsx` module, when present. Carried alongside
   * the component so the client hydrate entry can emit a static `import`
   * statement for each unique convention file — a component reference alone
   * can't survive the server→client boundary.
   */
  errorPath?: string;
  notFound?: NotFoundComponent;
  /** Absolute path to the `not-found.tsx` module, when present. */
  notFoundPath?: string;
  /** Absolute directory path. */
  path: string;
}

export interface ResolvedRoute {
  error?: ErrorComponent;
  isrCache?: { html: string; generatedAt: number; revalidate: number };
  mode: "ssr" | "ssg" | "isr";
  notFound?: NotFoundComponent;
  page: RuntimePage;
  path: string;
  pattern: string;
  routeChain: RuntimeRoute[];
  /**
   * Per-directory boundary chain, ordered shallow → deep. Only directories
   * that DECLARE at least one of `error.tsx` / `not-found.tsx` are included;
   * directories without conventions are skipped. Empty when no conventions
   * exist anywhere in the path.
   */
  segmentBoundaries: SegmentBoundary[];
  ssgHtml?: string;
}

export interface RootLayout {
  error?: ErrorComponent;
  errorPath?: string;
  notFound?: NotFoundComponent;
  notFoundPath?: string;
  path: string;
  route: RuntimeRoute;
}

export function loadProdRoutes(ctx: CompileContext): {
  root: RootLayout;
  routes: ResolvedRoute[];
} {
  const rootMod = ctx.modules[ctx.rootPath] as Record<string, unknown>;
  const rootExport = rootMod.route ?? rootMod.default;
  if (!(rootExport && isFurinRoute(rootExport) && rootExport.layout)) {
    throw new Error("[furin] root.tsx: createRoute() with layout not found in CompileContext.");
  }

  function resolveModuleComponent<T>(modPath: string | undefined): T | undefined {
    if (!modPath) {
      return;
    }
    const mod = ctx.modules[modPath] as { default?: T } | undefined;
    return mod?.default;
  }

  const root: RootLayout = {
    path: ctx.rootPath,
    route: rootExport,
    error: resolveModuleComponent(ctx.rootConventions?.errorPath),
    notFound: resolveModuleComponent(ctx.rootConventions?.notFoundPath),
  };

  const routes: ResolvedRoute[] = [];
  for (const { pattern, path, mode } of ctx.routes) {
    const pageMod = ctx.modules[path] as { default: RuntimePage };
    const page: RuntimePage = pageMod.default;
    if (!isFurinPage(page)) {
      throw new Error(`[furin] ${path}: invalid page module in CompileContext.`);
    }
    const routeChain = collectRouteChainFromRoute(page._route as RuntimeRoute);
    validateRouteChain(routeChain, root.route, path);
    const meta = ctx.routeMetadata?.[path];
    const boundaries = (meta?.segmentBoundaries ?? []).map((b) => ({
      ...b,
      error: resolveModuleComponent(b.errorPath),
      notFound: resolveModuleComponent(b.notFoundPath),
    })) as SegmentBoundary[];

    const error = boundaries.findLast((b) => b.error)?.error;
    const notFound = boundaries.findLast((b) => b.notFound)?.notFound;

    // Note: In production we store only the nearest segment-level convention
    // (error / notFound) and do NOT fall back to root.error / root.notFound here.
    // The dev-mode resolveNearestConvention() does include the root fallback,
    // and the render layer applies the runtime fallback (route.error ?? root.error)
    // when building the React element tree. This asymmetry is intentional:
    // loadProdRoutes records the static wiring so buildElement can place React
    // boundaries at the correct nesting depth, while the runtime fallback ensures
    // every route always has a safety-net component even if no boundary was
    // declared at any segment level.

    routes.push({
      pattern,
      page,
      path,
      routeChain,
      mode,
      segmentBoundaries: boundaries,
      error,
      notFound,
    });
  }

  return { root, routes };
}

export async function scanPages(pagesDir: string): Promise<{
  root: RootLayout;
  routes: ResolvedRoute[];
}> {
  const root = await scanRootLayout(pagesDir);
  const routes = await scanPageFiles(pagesDir, root);
  return { root, routes };
}

export async function scanRootLayout(pagesDir: string): Promise<RootLayout> {
  const rootPath = `${pagesDir}/root.tsx`;
  const ctx = getCompileContext();
  if (!(existsSync(rootPath) || ctx?.modules[rootPath])) {
    throw new Error("[furin] root.tsx: not found.");
  }

  const mod = (ctx?.modules[rootPath] ?? (await import(rootPath))) as Record<string, unknown>;
  const rootExport = mod.route ?? mod.default;
  if (!(rootExport && isFurinRoute(rootExport))) {
    throw new Error("[furin] root.tsx: createRoute() export not found.");
  }

  if (!rootExport.layout) {
    throw new Error("[furin] root.tsx: createRoute() has no layout.");
  }

  const notFoundEntry = await loadConventionComponent<NotFoundComponent>(pagesDir, "not-found");
  const errorEntry = await loadConventionComponent<ErrorComponent>(pagesDir, "error");
  return {
    path: rootPath,
    route: rootExport,
    notFound: notFoundEntry?.component,
    notFoundPath: notFoundEntry?.path,
    error: errorEntry?.component,
    errorPath: errorEntry?.path,
  };
}

const CONVENTION_FILE_NAMES = ["not-found", "error"] as const;
const SOURCE_MODULE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"] as const;

function isConventionFileName(name: string): boolean {
  return (CONVENTION_FILE_NAMES as readonly string[]).includes(name);
}

function getSourceModuleCandidates(dir: string, name: string): string[] {
  return SOURCE_MODULE_EXTENSIONS.map((ext) => `${dir}/${name}${ext}`);
}

/**
 * Result of a convention-file lookup. The `path` is the absolute module path
 * — callers that only care about the component discard it, but the hydrate
 * emission pipeline needs it to generate static `import` statements.
 */
interface ConventionLookup<T> {
  component: T;
  path: string;
}

async function loadConventionComponent<T>(
  dir: string,
  name: string
): Promise<ConventionLookup<T> | undefined> {
  const ctx = getCompileContext();
  for (const filePath of getSourceModuleCandidates(dir, name)) {
    if (existsSync(filePath) || ctx?.modules[filePath]) {
      const mod = (ctx?.modules[filePath] ?? (await import(filePath))) as {
        default?: T;
      };
      if (mod.default) {
        return { component: mod.default, path: filePath };
      }
    }
  }
  return;
}

async function scanPageFiles(pagesDir: string, root: RootLayout): Promise<ResolvedRoute[]> {
  const routes: ResolvedRoute[] = [];
  const notFoundCache = new Map<string, ConventionLookup<NotFoundComponent> | undefined>();
  const errorCache = new Map<string, ConventionLookup<ErrorComponent> | undefined>();

  for (const absolutePath of await collectPageFilePaths(pagesDir)) {
    if (
      !(SOURCE_MODULE_EXTENSIONS as readonly string[]).some((ext) => absolutePath.endsWith(ext))
    ) {
      continue;
    }

    const relativePath = absolutePath.replace(`${pagesDir}/`, "");
    const fileName = parse(relativePath).name;

    // Skip root.tsx, convention files (not-found, error), and files starting with _
    if (fileName.startsWith("_") || fileName === "root" || isConventionFileName(fileName)) {
      continue;
    }

    const notFound = await resolveNearestConvention<NotFoundComponent>(
      absolutePath,
      pagesDir,
      "not-found",
      notFoundCache,
      root.notFound
    );

    const errorComponent = await resolveNearestConvention<ErrorComponent>(
      absolutePath,
      pagesDir,
      "error",
      errorCache,
      root.error
    );

    const segmentBoundaries = await collectSegmentBoundaries(
      absolutePath,
      pagesDir,
      notFoundCache,
      errorCache
    );

    if (IS_DEV) {
      const devRoute = await buildDevRoute(absolutePath, relativePath, root);
      devRoute.notFound = notFound;
      devRoute.error = errorComponent;
      devRoute.segmentBoundaries = segmentBoundaries;
      routes.push(devRoute);
      continue;
    }

    const ctx = getCompileContext();
    const pageMod = (ctx?.modules[absolutePath] ?? (await import(absolutePath))) as {
      default: RuntimePage;
    };
    const page: RuntimePage = pageMod.default;
    if (!isFurinPage(page)) {
      throw new Error(`[furin] ${relativePath}: no valid createRoute().page() export found`);
    }

    const routeChain = collectRouteChainFromRoute(page._route as RuntimeRoute);

    validateRouteChain(routeChain, root.route, relativePath);

    routes.push({
      pattern: filePathToPattern(relativePath),
      page,
      path: absolutePath,
      routeChain,
      mode: resolveMode(page, routeChain),
      notFound,
      error: errorComponent,
      segmentBoundaries,
    });
  }

  return routes;
}

/**
 * Walks every directory from `pagesDir` down to the directory containing
 * `pageAbsolutePath` and records the OWN (not inherited) error.tsx /
 * not-found.tsx declared there. Directories without any convention file are
 * omitted so consumers can treat each entry as "a place where the user
 * authored a boundary on purpose".
 *
 * Uses the shared per-directory caches so sibling pages don't re-import the
 * same convention modules.
 */
async function collectSegmentBoundaries(
  pageAbsolutePath: string,
  pagesDir: string,
  notFoundCache: Map<string, ConventionLookup<NotFoundComponent> | undefined>,
  errorCache: Map<string, ConventionLookup<ErrorComponent> | undefined>
): Promise<SegmentBoundary[]> {
  const pageDir = pageAbsolutePath.slice(0, pageAbsolutePath.lastIndexOf("/"));

  // Accumulate directories from shallow → deep starting at pagesDir.
  const dirs: string[] = [pagesDir];
  if (pageDir.length > pagesDir.length) {
    const relativeTail = pageDir.slice(pagesDir.length + 1); // skip leading "/"
    const parts = relativeTail.split("/");
    let acc = pagesDir;
    for (const part of parts) {
      acc = `${acc}/${part}`;
      dirs.push(acc);
    }
  }

  const boundaries: SegmentBoundary[] = [];
  for (let depth = 0; depth < dirs.length; depth++) {
    const dir = dirs[depth] as string;

    if (!errorCache.has(dir)) {
      errorCache.set(dir, await loadConventionComponent<ErrorComponent>(dir, "error"));
    }
    if (!notFoundCache.has(dir)) {
      notFoundCache.set(dir, await loadConventionComponent<NotFoundComponent>(dir, "not-found"));
    }

    const errorEntry = errorCache.get(dir);
    const notFoundEntry = notFoundCache.get(dir);
    if (errorEntry || notFoundEntry) {
      boundaries.push({
        path: dir,
        depth,
        error: errorEntry?.component,
        errorPath: errorEntry?.path,
        notFound: notFoundEntry?.component,
        notFoundPath: notFoundEntry?.path,
      });
    }
  }

  return boundaries;
}

async function resolveNearestConvention<T>(
  pageAbsolutePath: string,
  pagesDir: string,
  conventionName: string,
  cache: Map<string, ConventionLookup<T> | undefined>,
  rootFallback: T | undefined
): Promise<T | undefined> {
  // Walk from the page's directory up to pagesDir looking for the convention file.
  // Cached per directory so repeated scans for sibling pages don't re-import.
  let dir = pageAbsolutePath.slice(0, pageAbsolutePath.lastIndexOf("/"));
  while (dir.length >= pagesDir.length) {
    if (!cache.has(dir)) {
      cache.set(dir, await loadConventionComponent<T>(dir, conventionName));
    }
    const found = cache.get(dir);
    if (found) {
      return found.component;
    }
    if (dir === pagesDir) {
      break;
    }
    dir = dir.slice(0, dir.lastIndexOf("/"));
  }
  return rootFallback;
}

async function buildDevRoute(
  absolutePath: string,
  relativePath: string,
  root: RootLayout
): Promise<ResolvedRoute> {
  // Import via the virtual namespace (registerDevPagePlugin must be called first)
  // so page files stay out of --hot's module graph. We still extract the route
  // chain at startup for type generation, guards, and mode resolution — matching
  // prod behavior exactly.
  let page: RuntimePage | undefined;
  let routeChain: RuntimeRoute[] = [];

  try {
    const pageMod = (await import(`${absolutePath}?furin-server&t=${Date.now()}`)) as {
      default: RuntimePage;
    };
    if (isFurinPage(pageMod.default)) {
      page = pageMod.default;
      routeChain = collectRouteChainFromRoute(page._route as RuntimeRoute);
      validateRouteChain(routeChain, root.route, relativePath);
    }
  } catch {
    // Page will be loaded on first request in createRoutePlugin as fallback
  }

  // Dev stub: a minimal RuntimePage that passes isFurinPage() but is never
  // actually rendered — createRoutePlugin always re-imports from disk in dev mode.
  const devStubPage: RuntimePage = {
    __type: "FURIN_PAGE",
    _route: { __type: "FURIN_ROUTE" },
    component: () => null,
  };

  return {
    pattern: filePathToPattern(relativePath),
    path: absolutePath,
    mode: page ? resolveMode(page, routeChain) : "ssr",
    // Still lazily re-imported on each request in createRoutePlugin for fresh code
    page: page ?? devStubPage,
    routeChain,
    // scanPageFiles() overwrites this with the real chain before the route
    // is pushed — present here to satisfy the ResolvedRoute required shape.
    segmentBoundaries: [],
  };
}

// ── Query-default redirect ──────────────────────────────────────────────────
// Validator-agnostic: after Elysia applies defaults (TypeBox, Zod, Valibot…),
// compare the raw URL query keys with the resolved ctx.query keys. If ctx.query
// contains keys absent from the URL, defaults were applied → 302 redirect to
// the canonical URL so the address bar always reflects the actual app state.

/** @internal Exported for unit testing. */
export function queryDefaultRedirectHook({ request, query, status, set }: Context) {
  const resolvedQuery = query as Record<string, unknown>;
  const queryKeys = Object.keys(resolvedQuery);
  if (queryKeys.length === 0) {
    return;
  }

  const rawParams = new URL(request.url).searchParams;

  let needsRedirect = false;
  for (const key of queryKeys) {
    if (!rawParams.has(key) && resolvedQuery[key] != null) {
      needsRedirect = true;
      break;
    }
  }
  if (!needsRedirect) {
    return;
  }

  const url = new URL(request.url);
  for (const [k, v] of Object.entries(resolvedQuery)) {
    if (v != null) {
      url.searchParams.set(k, String(v));
    }
  }

  set.headers.location = url.pathname + url.search;
  return status("Found");
}

type RouteModuleImport = (specifier: string) => Promise<Record<string, unknown>>;

function collectIntermediateLayoutDirs(pagePath: string, rootPath: string): string[] {
  const pageDir = pagePath.slice(0, pagePath.lastIndexOf("/"));
  const pagesDir = rootPath.slice(0, rootPath.lastIndexOf("/"));
  const layoutDirs: string[] = [];
  let dir = pageDir;

  while (dir.length > pagesDir.length) {
    layoutDirs.unshift(dir);
    dir = dir.slice(0, dir.lastIndexOf("/"));
  }

  return layoutDirs;
}

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

async function importFreshRouteModuleCandidate(
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
  let chainIdx = 1; // chain[0] is the root
  for (const layoutDir of layoutDirs) {
    if (chainIdx >= chain.length) {
      break;
    }
    const freshMod = await importFreshLayoutRouteModule(layoutDir, timestamp, resolveImport, ctx);
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

/** @internal Handles a request in dev mode — re-imports the page fresh on every request. */
async function handleDevRequest(
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

      const refreshedRoute: ResolvedRoute = { ...route, page, routeChain: chain };

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
async function renderDevISRWithLoaderCache(
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

  const result = await runLoaders(route, ctx, root.route);
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
async function renderDevSSGWithLoaderCache(
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

  const result = await runLoaders(route, ctx, root.route);
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

/** @internal Handles a production SSG route — sets ETags, Cache-Control, and Cache-Tag. */
async function handleSSGRequest(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout,
  buildId: string
): Promise<unknown> {
  const origin = new URL(ctx.request.url).origin;
  const entry = await prerenderSSG(route, ctx.params, root, origin, undefined);

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

// Standard structural keys on a TObject — everything else is a user-supplied option
// (e.g. additionalProperties, $id, description, title) and must be preserved.
const TOBJECT_STRUCTURAL_KEYS = new Set(["type", "properties", "required"]);

/**
 * Merges TObject schemas from all routeChain entries for a given key.
 * Properties are spread left-to-right (leaf wins on key conflict).
 * Object-level options (additionalProperties, $id, description, …) are also
 * merged with the same leaf-wins semantics so they are not silently dropped.
 * Returns undefined when no entry in the chain defines the key.
 *
 * @internal Exported for unit testing.
 */
export function mergeRouteSchemas(
  routeChain: RuntimeRoute[],
  key: "params" | "query"
): AnySchema | undefined {
  const schemas = routeChain.map((r) => r[key]).filter(Boolean) as Record<string, unknown>[];

  if (schemas.length === 0) {
    return;
  }
  if (schemas.length === 1) {
    return schemas[0] as AnySchema;
  }

  const mergedProperties = Object.assign(
    {},
    ...schemas.map((s) => (s.properties as Record<string, unknown>) ?? {})
  );

  const mergedOptions = Object.assign(
    {},
    ...schemas.map((s) =>
      Object.fromEntries(Object.entries(s).filter(([k]) => !TOBJECT_STRUCTURAL_KEYS.has(k)))
    )
  );

  return t.Object(mergedProperties, mergedOptions) as AnySchema;
}

export function createRoutePlugin(route: ResolvedRoute, root: RootLayout, buildId = ""): AnyElysia {
  const { pattern, routeChain } = route;

  const allParams = mergeRouteSchemas(routeChain, "params");
  const allQuery = mergeRouteSchemas(routeChain, "query");
  const hasQuerySchema = !!allQuery;

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
    // Redirect when Elysia applied query defaults (validator-agnostic)
    if (hasQuerySchema) {
      const redirect = queryDefaultRedirectHook(ctx);
      if (redirect) {
        return redirect;
      }
    }

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
      return handleDevRequest(route, ctx, root);
    }

    if (route.mode === "ssg") {
      return handleSSGRequest(route, ctx, root, buildId);
    }

    if (route.mode === "isr") {
      ctx.set.headers["cache-tag"] = resolvePath(route.pattern, ctx.params ?? {});
      return handleISR(route, ctx, root, buildId);
    }

    return renderSSR(route, ctx, root, undefined);
  });

  return plugin;
}

async function collectPageFilePaths(dir: string): Promise<string[]> {
  const files: string[] = [];

  // Sort by name so route order is reproducible across platforms / restarts.
  // readdir is hash-based on Linux ext4, alphabetical on macOS APFS — without
  // this sort, two pages that compile to the same URL pattern would resolve
  // non-deterministically depending on host. Sorting also makes the eventual
  // "duplicate route pattern" error reproducible (always the same winner).
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectPageFilePaths(absolutePath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

export function resolveMode(page: RuntimePage, routeChain: RuntimeRoute[]): "ssr" | "ssg" | "isr" {
  const routeConfig = page._route;
  const mode = routeConfig.mode ?? (page as { mode?: string }).mode;
  const revalidate = routeConfig.revalidate ?? (page as { revalidate?: number }).revalidate;

  if (mode) {
    return mode as "ssr" | "ssg" | "isr";
  }

  const hasLoader = routeChain.some((r) => r.loader) || !!page.loader;

  if (!hasLoader) {
    return "ssg";
  }

  if (typeof revalidate === "number" && revalidate >= 0) {
    return "isr";
  }

  return "ssr";
}

export function filePathToPattern(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/");
  const segments: string[] = [];

  for (const part of parts) {
    const name = parse(part).name;

    if (name === "index") {
      continue;
    }

    if (name.startsWith("[") && name.endsWith("]")) {
      const inner = name.slice(1, -1);

      if (inner.startsWith("...")) {
        segments.push("*");
        continue;
      }

      segments.push(`:${inner}`);
      continue;
    }

    segments.push(name);
  }

  return `/${segments.join("/")}`;
}

// ── /_furin/data endpoint ──────────────────────────────────────────────────────

/**
 * Builds a regex from a route pattern, extracts named capture groups for
 * each `:param` segment, and returns `{ regex, paramNames }`.
 */
function buildRouteRegex(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const regexSource = pattern
    .replace(/:[^/]+/g, (m) => {
      paramNames.push(m.slice(1));
      return "([^/]+)";
    })
    .replace(/\*/g, "(.*)");
  return { regex: new RegExp(`^${regexSource}$`), paramNames };
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
export function createDataEndpoint(routes: ResolvedRoute[], root: RootLayout): AnyElysia {
  const plugin = new Elysia();

  plugin.get(
    "/_furin/data",
    async (ctx) => {
      const rawPath = ctx.query.path;
      if (!rawPath || typeof rawPath !== "string") {
        return new Response("Missing required query param: path", { status: 400 });
      }

      // Parse the logical path (may include query string)
      let url: URL;
      try {
        url = new URL(rawPath, "http://localhost");
      } catch {
        return new Response("Invalid path", { status: 400 });
      }
      const pathname = url.pathname;

      // Find a matching route
      const matched = routes.reduce<{
        route: ResolvedRoute;
        params: Record<string, string>;
      } | null>((acc, route) => {
        if (acc) {
          return acc;
        }
        const { regex, paramNames } = buildRouteRegex(route.pattern);
        const m = regex.exec(pathname);
        if (!m) {
          return null;
        }
        const params: Record<string, string> = {};
        for (let i = 0; i < paramNames.length; i++) {
          const name = paramNames[i];
          if (name !== undefined) {
            params[name] = m[i + 1] ?? "";
          }
        }
        return { route, params };
      }, null);

      if (!matched) {
        return new Response("Route not found", { status: 404 });
      }

      // Build a synthetic Elysia-compatible context for the matched route.
      // Loaders receive request, params, query, set, headers, and cookie.
      const syntheticRequest = new Request(new URL(rawPath, ctx.request.url));
      const syntheticSet = { headers: {} as Record<string, string>, status: 200 as number };
      const syntheticCtx = {
        request: syntheticRequest,
        params: matched.params,
        query: Object.fromEntries(url.searchParams),
        set: syntheticSet,
        headers: ctx.headers,
        cookie: ctx.cookie,
        path: pathname,
        redirect: (url: string, status?: number) =>
          new Response(null, { status: status ?? 302, headers: { location: url } }),
        status: (code: number | string) => new Response(null, { status: Number(code) }),
      } as unknown as Context;

      const result = await runLoaders(matched.route, syntheticCtx, root.route);

      if (result.type === "redirect") {
        // Encode the redirect target as a special field for the client to follow
        const redirectUrl = new URL(
          result.response.headers.get("location") ?? "/",
          ctx.request.url
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
        return new Response("Internal server error", { status: 500 });
      }

      // Merge sync + deferred. toCrossJSONAsync awaits all Promises.
      const payload: Record<string, unknown> = {
        ...result.syncData,
        ...(result.deferredPromises ?? {}),
      };

      const serialized = await toCrossJSONAsync(payload);
      return new Response(`${JSON.stringify(serialized)}\n`, {
        headers: {
          "content-type": "application/x-ndjson",
          ...result.headers,
        },
      });
    },
    {
      query: t.Object({ path: t.Optional(t.String()) }),
    }
  );

  return plugin;
}
