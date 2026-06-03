import type { ReactNode } from "react";
import type { RuntimeRoute } from "../../client.ts";
import { wrapSegmentBoundaries } from "../../shared/boundaries.tsx";
import type { ErrorComponent } from "../../shared/error.ts";
import type { FurinNotFoundError, NotFoundComponent } from "../../shared/not-found.ts";
import type { ResolvedRoute, SegmentBoundary } from "../router/index.ts";
import { DefaultErrorFallback, DefaultNotFoundFallback } from "./default-screens.tsx";

export function buildElement(
  route: ResolvedRoute,
  data: Record<string, unknown>,
  rootLayout: RuntimeRoute
): ReactNode {
  const Component = route.page.component;
  let element: ReactNode = <Component {...data} />;

  // Index segmentBoundaries by depth for O(1) lookup during the wrap loop.
  // Directory depth `d` maps 1:1 to routeChain[d] in Furin's model (routeChain
  // is ordered shallow→deep, with index 0 being the root).
  const byDepth = new Map<number, SegmentBoundary>();
  // Defensive fallback: some legacy callers / tests construct a ResolvedRoute
  // without the segmentBoundaries field.
  for (const segment of route.segmentBoundaries ?? []) {
    byDepth.set(segment.depth, segment);
  }

  // Build inside-out. At each level we first wrap the accumulated subtree
  // with the boundary declared at this depth (so the boundary sits INSIDE
  // the layout at the same depth), THEN wrap with the layout itself.
  for (let i = route.routeChain.length - 1; i >= 1; i--) {
    element = wrapSegmentBoundaries(element, byDepth.get(i));
    const routeEntry = route.routeChain[i];
    if (routeEntry?.layout) {
      const Layout = routeEntry.layout;
      element = <Layout {...data}>{element}</Layout>;
    }
  }

  // Depth 0 = pagesDir itself = the root layout directory. Boundary wraps
  // everything below the root layout; root layout wraps the boundary.
  element = wrapSegmentBoundaries(element, byDepth.get(0));

  if (rootLayout.layout) {
    const RootLayoutComponent = rootLayout.layout;
    element = <RootLayoutComponent {...data}>{element}</RootLayoutComponent>;
  }

  return element;
}

export function buildNotFoundElement(
  component: NotFoundComponent | undefined,
  error: FurinNotFoundError
): ReactNode {
  const NotFound = component ?? DefaultNotFoundFallback;
  return <NotFound error={{ message: error.message, data: error.data }} />;
}

function errorMessageOf(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "";
}

const SERVER_RESET_NOOP = () => {
  /* reset is a client-only action; the response is already committed here */
};

/**
 * Builds the error element rendered when a loader (or the SSR shell) fails.
 *
 * @param component - User-declared `error.tsx` component, or `undefined` to
 *   fall back to the built-in `DefaultErrorScreen` with a generic message.
 * @param error - The original thrown value. Kept for `errorMessageOf` lookup
 *   when no explicit `messageOverride` is provided (e.g. shell-render errors).
 * @param digest - 10-hex-char digest correlating with server logs.
 * @param messageOverride - Pre-extracted public message. Set by the loader
 *   pipeline when the thrown value is a `Response` (whose body has already
 *   been consumed in `runLoaders`); pass `undefined` to derive the message
 *   from `error` via `errorMessageOf`.
 * @param status - HTTP status to surface in `ErrorProps.error.status`. The
 *   loader pipeline passes the thrown `Response.status` (default 500); the
 *   shell-error recovery path always passes 500.
 */
export function buildErrorElement(
  component: ErrorComponent | undefined,
  error: unknown,
  digest: string,
  messageOverride: string | undefined,
  status: number
): ReactNode {
  const ErrorView = component ?? DefaultErrorFallback;
  let message: string;
  if (component) {
    message = messageOverride ?? errorMessageOf(error);
  } else {
    message = "An unexpected error occurred.";
  }
  return <ErrorView error={{ message, digest, status }} reset={SERVER_RESET_NOOP} />;
}
