// biome-ignore-all lint/performance/noBarrelFile: server/router barrel is the public surface of the routing module
export { collectRouteTags, loadProdRoutes, scanPages, scanRootLayout } from "./discovery.ts";
export {
  computeRouteDependencies,
  importFreshRouteModuleCandidate,
  rebuildDevRoute,
  refreshLayoutChain,
  renderDevISRWithLoaderCache,
  renderDevSSGWithLoaderCache,
} from "./hmr.ts";
export {
  buildRouteRegex,
  collectIntermediateLayoutDirs,
  compareRouteSpecificity,
  escapeRegExpChar,
  filePathToPattern,
  resolveMode,
} from "./patterns.ts";
export { createDataEndpoint, createRoutePlugin } from "./plugin.ts";
export {
  applySchemaDefaults,
  detectQueryDefaultRedirect,
  mergeRouteSchemas,
  parseDataEndpointPath,
  queryDefaultRedirectHook,
} from "./schemas.ts";
export type { ResolvedRoute, RootLayout, SegmentBoundary } from "./types.ts";
