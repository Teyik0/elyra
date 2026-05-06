import { Component, Fragment, type ReactNode } from "react";
import { type ErrorComponent, getPublicErrorMessage } from "../error.ts";
import { isNotFoundError, type NotFoundComponent } from "../not-found.ts";
import { isFurinServerError } from "../server-error.ts";
import { DefaultErrorScreen, DefaultNotFoundScreen } from "./default-screens.tsx";
import { computeErrorDigest } from "./digest.ts";

const DefaultErrorFallback: ErrorComponent = ({ error, reset }) => (
  <DefaultErrorScreen digest={error.digest} message={error.message} reset={reset} />
);

/**
 * Default HTTP status surfaced to error UIs when the caught error has no
 * intrinsic status (e.g. a thrown `Error`, a non-Error throw). The loader
 * pipeline produces a `FurinServerError` with the right status when a thrown
 * `Response` is the cause; everything else collapses to 500.
 */
const DEFAULT_ERROR_STATUS = 500;

const DefaultNotFoundFallback: NotFoundComponent = ({ error }) => (
  <DefaultNotFoundScreen message={error.message} />
);

const SERVER_RESET_NOOP = () => {
  /* reset is a client-only action; on the server the response is already committed */
};

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Server-provided digest for an error rendered server-side. Honoured only
   * for the FIRST error this boundary surfaces post-hydration — i.e. when the
   * latched error is plausibly the same one the server already logged. After
   * any reset, or when subsequent client-side errors are caught, the boundary
   * computes a fresh digest from the actual caught error so distinct failures
   * keep distinct IDs.
   */
  digest?: string;
  /** Component rendered when an error is caught. Omit to use the built-in default. */
  fallback?: ErrorComponent;
  /**
   * Invoked AFTER the boundary has cleared its local error state. Slice 7
   * wires this to `router.navigate(currentHref, { force: true })` so the
   * loader re-runs.
   */
  onReset?: () => void;
  /**
   * When this value changes the boundary clears its error state, effectively
   * retrying the render of `children`. Slice 7 drives this from router
   * navigation success.
   */
  resetKey?: string | number;
}

interface ErrorBoundaryState {
  /**
   * Digest computed at the moment the error was latched. Stored in state so
   * each distinct caught error gets its own ID, instead of all of them
   * inheriting the server-provided `digest` prop.
   */
  digest: string | null;
  /** Unmount/remount counter — bumped on reset to force React to discard
   *  the previous subtree (including any broken state). */
  epoch: number;
  error: Error | null;
}

/**
 * Catches generic errors thrown during render of `children`. Lets
 * `FurinNotFoundError` bubble past so a sibling `<FurinNotFoundBoundary>`
 * can handle it.
 *
 * Must be a class: React error catching (`getDerivedStateFromError`,
 * `componentDidCatch`) has no function-component equivalent.
 */
// biome-ignore lint/style/useReactFunctionComponents: React error boundaries require a class component.
export class FurinErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = {
    digest: null,
    epoch: 0,
    error: null,
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    // Compute the digest right at catch-time so the value is anchored to THIS
    // specific error instance. Doing it here (vs. lazily in render) also means
    // a re-render with the same latched error keeps the same ID.
    return { digest: computeErrorDigest(error), error };
  }

  override componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.reset();
    }
  }

  reset = () => {
    // setState is async; running onReset BEFORE the state has actually flipped
    // would expose stale `state.error` to anything the callback transitively
    // reads (e.g. router.refresh re-rendering this very subtree). The second
    // argument to setState fires after the commit, which is what we want.
    this.setState(
      (s) => ({ digest: null, epoch: s.epoch + 1, error: null }),
      () => {
        this.props.onReset?.();
      }
    );
  };

  override render(): ReactNode {
    const { error, epoch, digest } = this.state;
    if (error) {
      // notFound() is a control-flow signal — bubble it up to the nearest
      // FurinNotFoundBoundary rather than displaying an error UI for it.
      if (isNotFoundError(error)) {
        throw error;
      }
      const Fallback = this.props.fallback ?? DefaultErrorFallback;
      // Digest precedence:
      //   1. FurinServerError.digest — when the server emitted an error
      //      sentinel through the SPA-nav payload, the synthesized error
      //      carries the server's own digest so logs correlate without
      //      recomputing a different hash from a synthetic stack.
      //   2. state.digest — computed at catch time, always correct for the
      //      ACTUAL caught error.
      //   3. props.digest — the server-rendered digest, only meaningful for
      //      the very first error post-hydration; we still honour it as a
      //      last-resort fallback in case state.digest is somehow missing
      //      (e.g. tests that inject state by hand).
      //   4. recompute on the spot — defensive, should never be reached.
      const serverDigest = isFurinServerError(error) ? error.digest : undefined;
      const finalDigest = serverDigest ?? digest ?? this.props.digest ?? computeErrorDigest(error);
      const message = this.props.fallback ? error.message : getPublicErrorMessage(error);
      // Status precedence: FurinServerError carries the original Response.status
      // (or the loader's computed 500 for non-Response throws); everything else
      // collapses to the default 500.
      const status = isFurinServerError(error) ? error.status : DEFAULT_ERROR_STATUS;
      return (
        <Fallback
          error={{ message, digest: finalDigest, status }}
          reset={typeof window === "undefined" ? SERVER_RESET_NOOP : this.reset}
        />
      );
    }
    // The `key` trick ensures that after a reset, children remount fresh
    // rather than retaining stale state from the failed render.
    return <Fragment key={epoch}>{this.props.children}</Fragment>;
  }
}

interface NotFoundBoundaryProps {
  children: ReactNode;
  fallback?: NotFoundComponent;
  resetKey?: string | number;
}

interface NotFoundBoundaryState {
  epoch: number;
  error: Error | null;
}

/**
 * Catches `FurinNotFoundError` (thrown by `notFound()`) and renders the
 * nearest not-found UI. Generic errors are re-thrown from render() so a
 * parent `<FurinErrorBoundary>` can handle them.
 *
 * Must be a class: React error catching has no function-component equivalent.
 */
// biome-ignore lint/style/useReactFunctionComponents: React error boundaries require a class component.
export class FurinNotFoundBoundary extends Component<NotFoundBoundaryProps, NotFoundBoundaryState> {
  override state: NotFoundBoundaryState = { epoch: 0, error: null };

  static getDerivedStateFromError(error: Error): Partial<NotFoundBoundaryState> {
    return { error };
  }

  override componentDidUpdate(prevProps: NotFoundBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState((s) => ({ error: null, epoch: s.epoch + 1 }));
    }
  }

  override render(): ReactNode {
    const { error, epoch } = this.state;
    if (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
      const Fallback = this.props.fallback ?? DefaultNotFoundFallback;
      return <Fallback error={{ message: error.message, data: error.data }} />;
    }
    return <Fragment key={epoch}>{this.props.children}</Fragment>;
  }
}
