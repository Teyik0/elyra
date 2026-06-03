// biome-ignore-all lint/performance/noBarrelFile: client/router barrel — public surface of the SPA router
export { buildPageElement, buildRouterTree } from "./boundary-tree.tsx";
export { RouterContext, useRouter } from "./context.ts";
export {
  generateHistoryKey,
  getHistoryKey,
  isStaleDeployResponse,
  SCROLL_STORAGE_KEY,
  saveScrollPosition,
} from "./history.ts";
export {
  applyRevalidateHeader,
  buildHref,
  normalizeHref,
  normalizePath,
  shouldAutoRefreshPath,
  shouldInterceptClick,
  shouldRefetch,
  stripHashFromHref,
  TRAILING_SLASHES_RE,
  toLogical,
} from "./link-utils.ts";
export { RouterProvider } from "./provider.tsx";
export {
  buildDataEndpoint,
  buildNotFoundPageElement,
  classifySpaResponse,
  detectStaticMode,
  parsePageResponse,
  pickDeepestNotFound,
} from "./spa-response.ts";
export type {
  CacheEntry,
  ClientRoute,
  ClientSegmentBoundary,
  LinkProps,
  LoadedClientRoute,
  PreloadStrategy,
  RootBoundaryOptions,
  RouteManifest,
  RouterContextValue,
  RouterProviderProps,
  RouterState,
  RouteSearch,
  RouteTo,
  SpaResponseKind,
} from "./types.ts";
