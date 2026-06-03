import type React from "react";
import { createElement } from "react";
import type { RuntimeRoute } from "../../client.ts";
import { FurinErrorBoundary } from "../../server/render/boundaries.tsx";
import { FurinServerError } from "../../server/server-error.ts";
import { type BoundaryOptions, wrapSegmentBoundaries } from "../../shared/boundaries.tsx";
import { RouterContext } from "./context.ts";
import type {
  ClientSegmentBoundary,
  LoadedClientRoute,
  RootBoundaryOptions,
  RouterContextValue,
} from "./types.ts";

/**
 * Composes the outermost tree produced by `RouterProvider`:
 *
 *   <RouterContext.Provider value={context}>
 *     <FurinErrorBoundary digest onReset resetKey>
 *       {pageElement}
 *     </FurinErrorBoundary>
 *   </RouterContext.Provider>
 *
 * `RouterContext.Provider` is the OUTERMOST element so that a root-level
 * `error.tsx` rendered by the boundary can still call `useRouter()` / render
 * `<Link>` (the context is in scope above the boundary).
 *
 * @internal Exported for unit testing only.
 */
export function buildRouterTree(
  context: RouterContextValue,
  pageElement: React.ReactNode,
  options: RootBoundaryOptions
): React.ReactElement {
  return (
    <RouterContext.Provider value={context}>
      <FurinErrorBoundary {...options}>{pageElement}</FurinErrorBoundary>
    </RouterContext.Provider>
  );
}

/**
 * Internal helper component that throws a `FurinServerError` during render
 * so the nearest `<FurinErrorBoundary>` catches it and renders the user's
 * `error.tsx` (or the built-in default) — without forcing a full-page reload.
 */
function RouteErrorThrower({
  error,
}: {
  error: { digest: string; message: string; status: number };
}): React.ReactElement {
  throw new FurinServerError(error);
}

/** @internal Exported for unit testing only. */
export function buildPageElement(
  match: LoadedClientRoute,
  root: RuntimeRoute | null,
  data: Record<string, unknown>,
  options: BoundaryOptions | undefined,
  error: { digest: string; message: string; status: number } | undefined
): React.ReactNode {
  let element: React.ReactNode = error
    ? createElement(RouteErrorThrower, { error })
    : createElement(match.component, data);

  // Collect non-root layouts from the route chain (bottom-up)
  const allLayouts: React.ComponentType<Record<string, unknown> & { children: React.ReactNode }>[] =
    [];
  let current: RuntimeRoute | undefined = match.pageRoute;
  while (current) {
    if (current.layout) {
      allLayouts.unshift(current.layout);
    }
    current = current.parent;
  }

  // If a root layout exists, the first entry in allLayouts IS the root — skip it here
  const layouts = root ? allLayouts.slice(1) : allLayouts;

  // Index boundaries by depth for O(1) lookup. `layouts[i]` corresponds to
  // route-chain depth `i + 1` (depth 0 = root layout, handled separately).
  const byDepth = new Map<number, ClientSegmentBoundary>();
  for (const segment of match.segmentBoundaries ?? []) {
    byDepth.set(segment.depth, segment);
  }

  // Inside-out: at each layout level wrap the subtree with its same-depth
  // boundary (so the boundary sits INSIDE the layout), then wrap with the
  // layout itself.
  for (let i = layouts.length - 1; i >= 0; i--) {
    element = wrapSegmentBoundaries(element, byDepth.get(i + 1), options);
    const Layout = layouts[i];
    if (Layout) {
      // biome-ignore lint/suspicious/noExplicitAny: spread loses `children` type info for createElement
      element = createElement(Layout, { ...data } as any, element);
    }
  }

  // Depth 0 boundary wraps EVERYTHING below the root layout.
  element = wrapSegmentBoundaries(element, byDepth.get(0), options);

  if (root?.layout) {
    // biome-ignore lint/suspicious/noExplicitAny: spread loses `children` type info for createElement
    element = createElement(root.layout, { ...data } as any, element);
  }

  return element;
}
