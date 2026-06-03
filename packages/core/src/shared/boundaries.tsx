import type { ReactNode } from "react";
import { FurinErrorBoundary, FurinNotFoundBoundary } from "../server/render/boundaries.tsx";
import type { ErrorComponent } from "./error.ts";
import type { NotFoundComponent } from "./not-found.ts";

/**
 * Options passed to `wrapSegmentBoundaries` when running on the client.
 * The server path omits them entirely.
 */
export interface BoundaryOptions {
  onReset?: () => void;
  resetKey?: string | number;
}

/**
 * Minimal shape of a segment boundary descriptor, accepted by both server-side
 * `SegmentBoundary` and client-side `ClientSegmentBoundary`.
 */
export interface SegmentBoundaryLike {
  error?: ErrorComponent;
  notFound?: NotFoundComponent;
}

/**
 * Wraps `inner` with the boundary pair declared at a single segment depth.
 *
 * The ordering is deliberate and MUST be kept identical on server **and**
 * client so that hydration sees the exact same React tree:
 *
 *   <FurinErrorBoundary>
 *     <FurinNotFoundBoundary>{inner}</FurinNotFoundBoundary>
 *   </FurinErrorBoundary>
 *
 * `FurinErrorBoundary` is OUTSIDE because it re-throws `FurinNotFoundError`
 * during render, allowing an ancestor not-found boundary to catch it. Placing
 * the not-found boundary inside would mean the same-depth error boundary
 * catches a `notFound()` throw first, latches onto it, and the re-throw would
 * not find a `NotFoundBoundary` deeper than itself — it needs one higher up.
 *
 * @param inner    - React subtree to wrap.
 * @param segment  - Boundary descriptor for this depth (may be undefined).
 * @param options  - Optional client-side reset options (ignored on server).
 * @returns The wrapped React node.
 */
export function wrapSegmentBoundaries(
  inner: ReactNode,
  segment: SegmentBoundaryLike | undefined,
  options?: BoundaryOptions | undefined
): ReactNode {
  if (!segment) {
    return inner;
  }

  let wrapped: ReactNode = inner;

  if (segment.notFound) {
    wrapped = (
      <FurinNotFoundBoundary fallback={segment.notFound} resetKey={options?.resetKey}>
        {wrapped}
      </FurinNotFoundBoundary>
    );
  }

  if (segment.error) {
    wrapped = (
      <FurinErrorBoundary
        fallback={segment.error}
        onReset={options?.onReset}
        resetKey={options?.resetKey}
      >
        {wrapped}
      </FurinErrorBoundary>
    );
  }

  return wrapped;
}
