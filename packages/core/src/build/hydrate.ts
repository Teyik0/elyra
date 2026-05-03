import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateIndexHtml } from "../render/shell";
import type { ResolvedRoute } from "../router";
import { writeRouteTypes } from "./route-types";
import type { BuildClientOptions } from "./types";

/**
 * Generates the client hydration entry.
 *
 * Renders into <div id="root"> (the SSR outlet element) and retains the React
 * root across hot reloads via import.meta.hot.data.root so React Fast Refresh
 * applies in-place instead of remounting.
 *
 * @param routes - Resolved routes to include in the hydration manifest.
 * @param rootLayout - Absolute path to the root layout module.
 * @param basePath - Optional sub-path prefix for static deployments (e.g. "/furin").
 *   When set, the generated code strips the prefix from `window.location.pathname`
 *   before matching routes, and passes `basePath` to `RouterProvider` so SPA
 *   navigation uses the correct physical URLs.
 */
export function generateHydrateEntry(
  routes: ResolvedRoute[],
  rootLayout: string,
  basePath: string
): string {
  // Deduplicate convention-file paths across all routes so each physical file
  // produces ONE static import, even when shared by many routes (e.g. the
  // pages-dir-level error.tsx covers every page at depth 0).
  const conventionIdents = new Map<string, string>();
  const getIdent = (filePath: string | undefined): string | undefined => {
    if (!filePath) {
      return;
    }
    const existing = conventionIdents.get(filePath);
    if (existing) {
      return existing;
    }
    const ident = `__furin_bnd_${conventionIdents.size}`;
    conventionIdents.set(filePath, ident);
    return ident;
  };

  const routeEntries: string[] = [];

  for (const route of routes) {
    const resolvedPage = route.path.replace(/\\/g, "/");
    const regexPattern = route.pattern.replace(/:[^/]+/g, "([^/]+)").replace(/\*/g, "(.*)");

    // Emit one boundary literal per segment that actually carries a convention
    // file — segments that only declare one of the two are emitted with the
    // missing field omitted entirely (keeps the generated JS tidy).
    const boundaryLiterals: string[] = [];
    for (const seg of route.segmentBoundaries ?? []) {
      const errorIdent = getIdent(seg.errorPath);
      const notFoundIdent = getIdent(seg.notFoundPath);
      if (!(errorIdent || notFoundIdent)) {
        continue;
      }
      const parts = [`depth: ${seg.depth}`];
      if (errorIdent) {
        parts.push(`error: ${errorIdent}`);
      }
      if (notFoundIdent) {
        parts.push(`notFound: ${notFoundIdent}`);
      }
      boundaryLiterals.push(`{ ${parts.join(", ")} }`);
    }
    const boundariesField =
      boundaryLiterals.length > 0 ? `, segmentBoundaries: [${boundaryLiterals.join(", ")}]` : "";

    routeEntries.push(
      ` { pattern: "${route.pattern}", regex: new RegExp("^${regexPattern}$"), load: () => import("${resolvedPage}")${boundariesField} }`
    );
  }

  // Collect all deduplicated convention-file imports. Emitted BEFORE the
  // route array so the idents are in scope when the array literal is built.
  const conventionImportLines = [...conventionIdents.entries()]
    .map(([filePath, ident]) => `import ${ident} from "${filePath.replace(/\\/g, "/")}";`)
    .join("\n");

  // basePath stripping: when deployed to a sub-path (e.g. /furin), strip the
  // prefix before route matching so patterns like /docs/routing still work.
  const basePathLiteral = JSON.stringify(basePath);
  // Strip basePath only when it matches on a path boundary (prevents "/furin" from
  // matching "/furinity/foo"). The boundary holds when the pathname ends exactly
  // at the prefix length OR the next character is "/".
  // Trailing slashes are also stripped so "/docs/routing/" matches the route
  // pattern "/docs/routing" — GitHub Pages and many static hosts append them.
  const pathnameExpr = basePath
    ? `(() => { const p = window.location.pathname; const b = ${basePathLiteral}; const stripped = (p.startsWith(b) && (p.length === b.length || p[b.length] === "/")) ? p.slice(b.length) || "/" : p; return stripped === "/" ? "/" : stripped.replace(/\\/+$/, ""); })()`
    : `window.location.pathname.replace(/\\/+$/, "") || "/"`;

  // Log drain endpoint: prepend basePath so the request goes to the correct origin path.
  const logEndpoint = basePath
    ? `${JSON.stringify(basePath)} + "/_furin/ingest"`
    : `"/_furin/ingest"`;

  // RouterProvider receives basePath so navigate() / Link push physical paths.
  const routerProviderDefaults = `\n      autoRefresh: true,\n      basePath: ${basePathLiteral},\n      defaultPreload: "intent",\n      defaultPreloadDelay: 50,\n      defaultPreloadStaleTime: 30000,\n      prefetchCacheSize: 50,`;

  const conventionImportsBlock = conventionImportLines ? `\n${conventionImportLines}` : "";

  return `import { hydrateRoot, createRoot } from "react-dom/client";
import { createElement } from "react";
import { initLogger, log } from "evlog";
import { createHttpLogDrain } from "evlog/http";
import { RouterProvider } from "@teyik0/furin/link";
import { fromCrossJSON } from "@teyik0/furin/link";
import type { SerovalNode } from "seroval";
import { route as root } from "${rootLayout.replace(/\\/g, "/")}";${conventionImportsBlock}

initLogger({ drain: createHttpLogDrain({ drain: { endpoint: ${logEndpoint} } }) });

const routes = [
${routeEntries.join(",\n")}
];

const pathname = ${pathnameExpr};
const _match = routes.find((r) => r.regex.test(pathname));

// Parse the server-embedded loader payload up front. It carries:
//   - normal loader props under arbitrary keys,
//   - __furinError.digest when SSR caught an error,
//   - __furinStatus: 404 when the server rendered the catch-all not-found
//     (direct load to an unknown URL, emitted by renderRootNotFound) OR when
//     a matched loader threw notFound(). The latter still has a _match; the
//     former does not — so the two cases fork on _match below.
const dataEl = document.getElementById("__FURIN_DATA__");
const loaderData = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};

// ── Deferred data hydration ─────────────────────────────────────────────────
// window.__FURIN_DEFERRED__ is injected by the server when a loader returns
// defer(). It carries:
//   - _data: sync fields (mirrors __FURIN_DATA__)
//   - _chunks: raw CrossJSON chunks keyed by field name (from late <script> tags)
// We deserialise each chunk with fromCrossJSON and create a Promise so <Await>
// components receive a proper resolved Promise instead of the raw CrossJSON node.
const __deferred = (window as any).__FURIN_DEFERRED__;
const deferredData: Record<string, Promise<unknown>> = {};
if (__deferred && __deferred._chunks) {
  // Patch resolve/reject so any chunks that arrive after this script runs
  // (edge-case: non-deferred inline scripts racing with defer) also work.
  __deferred.resolve = (key: string, chunk: SerovalNode) => {
    const r = __deferred._resolvers[key];
    if (r) {
      r.resolve(fromCrossJSON(chunk, {}));
    } else {
      __deferred._chunks[key] = { a: 0, v: chunk };
    }
  };
  __deferred.reject = (key: string, chunk: SerovalNode) => {
    const r = __deferred._resolvers[key];
    if (r) {
      r.reject(fromCrossJSON(chunk, {}));
    } else {
      __deferred._chunks[key] = { a: 1, v: chunk };
    }
  };
  for (const key of Object.keys(__deferred._chunks)) {
    const entry = __deferred._chunks[key] as { a: 0 | 1; v: SerovalNode };
    const p = __deferred.getPromise(key) as Promise<unknown>;
    const resolver = __deferred._resolvers[key];
    const value = fromCrossJSON(entry.v, {});
    if (entry.a === 0) {
      resolver.resolve(value);
    } else {
      resolver.reject(value);
    }
    deferredData[key] = p;
  }
}
const rootEl = document.getElementById("root") as HTMLElement;

// Eagerly load only the current page module for initial hydration.
// All other pages are loaded on demand when the user navigates to them.
// Wrapped in an async IIFE to avoid top-level await, which causes Bun's HTML
// bundler to misidentify which chunk to reference as the entry in index.html.
(async () => {
  let app;
  if (_match) {
    const _mod = await _match.load();
    const match = { ..._match, component: _mod.default.component, pageRoute: _mod.default._route };

    const isNotFound = loaderData.__furinStatus === 404;

    app = createElement(RouterProvider, {
      routes,
      root,
      initialMatch: match,
      initialData: { ...loaderData, ...deferredData },
      initialDigest: loaderData.__furinError?.digest,
      initialNotFound: isNotFound ? (loaderData.__furinNotFound ?? loaderData) : undefined,${routerProviderDefaults}
    } as any);
  } else if (loaderData.__furinStatus === 404) {
    // Direct load to an unknown URL. The server sent the root not-found UI
    // already rendered into the DOM. Mount RouterProvider with a null match
    // so the provider boots into its not-found branch, hydrating that exact
    // tree INSIDE a live RouterContext. Without this, Links in the 404 UI
    // (e.g. the default screen's "Go Home" button) hit the useRouter()
    // fallback that does a full window.location assignment — a jarring reload.
    // Strip the server-only signal keys before handing data to components.
    const { __furinStatus: _s, __furinNotFound: _n, ...cleanData } = loaderData;
    app = createElement(RouterProvider, {
      routes,
      root,
      initialMatch: null,
      initialData: cleanData,
      initialDigest: loaderData.__furinError?.digest,
      initialNotFound: loaderData.__furinNotFound ?? {},${routerProviderDefaults}
    } as any);
  } else {
    // No match and no 404 signal — either the client bundle is out of sync
    // with the server (stale deploy) or the server returned something we
    // don't know how to hydrate. Bail loudly; the page stays static.
    log.error({ action: "hydrate_no_match", pathname });
    return;
  }

  if (import.meta.hot) {
    // Dev mode — preserve root across HMR using a window global.
    // window is the only object that survives Bun's module re-evaluation.
    // biome-ignore lint/suspicious/noExplicitAny: dev-only HMR global
    const existingRoot = (window as any).__FURIN_ROOT__;
    if (existingRoot) {
      // Already mounted — reconciliation, NOT hydration. React Fast Refresh
      // patched the component in-place, now re-render with the new module.
      existingRoot.render(app);
      // The initialData embedded in the DOM is stale (from the original SSR).
      // Trigger a loader-data refresh so the component renders with fresh
      // server state, avoiding hydration mismatches after a _route.tsx edit.
      const hmrRefresh = (window as any).__FURIN_HMR_REFRESH__;
      if (hmrRefresh) {
        requestAnimationFrame(() => hmrRefresh());
      }
    } else if (rootEl.innerHTML.trim()) {
      // First load with SSR content — hydrateRoot renders on construction
      const root = hydrateRoot(rootEl, app);
      // biome-ignore lint/suspicious/noExplicitAny: dev-only HMR global
      (window as any).__FURIN_ROOT__ = root;
    } else {
      // First load without SSR content — createRoot requires explicit .render()
      const root = createRoot(rootEl);
      root.render(app);
      // biome-ignore lint/suspicious/noExplicitAny: dev-only HMR global
      (window as any).__FURIN_ROOT__ = root;
    }
  } else if (rootEl.innerHTML.trim()) {
    hydrateRoot(rootEl, app);
  } else {
    createRoot(rootEl).render(app);
  }

  log.info({ action: "hydrate_complete", pathname });
})().catch((err: unknown) => {
  log.error({ action: "hydrate_failed", pathname, error: String(err) });
});
`;
}

/**
 * Writes _hydrate.tsx + index.html to outDir for dev (Bun HMR) mode.
 *
 * Only rewrites a file when its content has actually changed so Bun's --hot
 * watcher does not trigger a spurious reload on every server restart.
 */
export function writeDevFiles(
  routes: ResolvedRoute[],
  { outDir, rootLayout, basePath }: BuildClientOptions,
  projectRoot: string
): void {
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const hydrateCode = generateHydrateEntry(routes, rootLayout, basePath);
  const hydratePath = join(outDir, "_hydrate.tsx");
  const existingHydrate = existsSync(hydratePath) ? readFileSync(hydratePath, "utf8") : "";
  if (hydrateCode !== existingHydrate) {
    writeFileSync(hydratePath, hydrateCode);
  }

  const indexHtml = generateIndexHtml();
  const indexPath = join(outDir, "index.html");
  const existingIndex = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  if (indexHtml !== existingIndex) {
    writeFileSync(indexPath, indexHtml);
  }

  writeRouteTypes(routes, projectRoot);

  console.log(
    "[furin] Dev files written (.furin/_hydrate.tsx + .furin/index.html + furin-env.d.ts)"
  );
}
