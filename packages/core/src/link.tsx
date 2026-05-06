import type React from "react";
import { createElement, useCallback, useEffect, useRef } from "react";
import {
  buildHref,
  type LinkProps,
  normalizeHref,
  RouterContext,
  type RouterContextValue,
  type RouteTo,
  useRouter,
} from "./router-provider.tsx";

// biome-ignore lint/performance/noBarrelFile: re-exporting router-provider symbols preserves backward compatibility for @teyik0/furin/link consumers
export * from "./router-provider.tsx";

// ── Link ───────────────────────────────────────────────────────────────────────

interface LinkView {
  extraProps: React.AnchorHTMLAttributes<HTMLAnchorElement>;
  href: string;
  isActive: boolean;
  logicalHref: string;
  resolvedChildren: React.ReactNode;
}

/**
 * Shared href/active-state/props computation used by both LinkInteractive (CSR)
 * and renderLinkElement (SSR). Centralising this keeps the two render paths in sync.
 */
function computeLinkView<To extends RouteTo>(
  {
    to,
    search,
    hash,
    children,
    activeProps,
    inactiveProps,
  }: Pick<LinkProps<To>, "to" | "search" | "hash" | "children" | "activeProps" | "inactiveProps">,
  router: RouterContextValue
): LinkView {
  const logicalHref = buildHref(
    to as string,
    search as Record<string, unknown> | null | undefined,
    hash
  );
  const logicalHrefWithoutHash = buildHref(
    to as string,
    search as Record<string, unknown> | null | undefined,
    undefined
  );
  const isAbsolute =
    logicalHref.startsWith("http://") ||
    logicalHref.startsWith("https://") ||
    logicalHref.startsWith("//");
  const href = isAbsolute ? logicalHref : router.basePath + logicalHref;
  const isActive = !isAbsolute && router.currentHref === normalizeHref(logicalHrefWithoutHash);
  const resolvedChildren = typeof children === "function" ? children({ isActive }) : children;
  const extraProps: React.AnchorHTMLAttributes<HTMLAnchorElement> = {
    ...(inactiveProps && !isActive ? inactiveProps() : {}),
    ...(activeProps ? activeProps({ isActive }) : {}),
  };
  return { logicalHref, href, isActive, resolvedChildren, extraProps };
}

/**
 * Full interactive Link — only rendered on the client where hooks are safe.
 * Never rendered during SSR so it's immune to duplicate-React-instance issues
 * that can arise when page modules are loaded via the furin-dev-page virtual
 * namespace (Bun HMR).
 */
function LinkInteractive<To extends RouteTo>({
  to,
  search,
  hash,
  preload,
  preloadDelay,
  preloadStaleTime,
  replace,
  disabled,
  resetScroll,
  activeProps,
  inactiveProps,
  onClick,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  children,
  // @ts-expect-error: defensive strip of accidental href prop passed via spread
  href: _href,
  ...anchorProps
}: LinkProps<To>): React.ReactElement {
  const router = useRouter();
  const anchorRef = useRef<HTMLAnchorElement>(null);
  const intentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // logicalHref: route-relative path (no basePath), used for navigation + active state.
  // physicalHref (href): what the browser sees — basePath + logicalHref.
  const { logicalHref, href, isActive, resolvedChildren, extraProps } = computeLinkView(
    { to, search, hash, children, activeProps, inactiveProps },
    router
  );
  const effectivePreload = preload ?? router.defaultPreload;
  const effectiveDelay = preloadDelay ?? router.defaultPreloadDelay;
  const effectiveStaleTime = preloadStaleTime ?? router.defaultPreloadStaleTime;

  const triggerPrefetch = useCallback(() => {
    // prefetch() expects the logical href (no basePath prefix).
    router.prefetch(logicalHref, { staleTime: effectiveStaleTime });
  }, [router, logicalHref, effectiveStaleTime]);

  // "render": preload immediately on mount
  useEffect(() => {
    if (effectivePreload === "render") {
      triggerPrefetch();
    }
  }, [effectivePreload, triggerPrefetch]);

  // "viewport": preload when link enters viewport
  useEffect(() => {
    if (effectivePreload !== "viewport" || !anchorRef.current) {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          triggerPrefetch();
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(anchorRef.current);
    return () => observer.disconnect();
  }, [effectivePreload, triggerPrefetch]);

  // Clear any pending intent prefetch timer on unmount to avoid leaking
  // setTimeout callbacks between test cases (or across re-renders).
  useEffect(
    () => () => {
      if (intentTimerRef.current !== null) {
        clearTimeout(intentTimerRef.current);
        intentTimerRef.current = null;
      }
    },
    []
  );

  const isInternal = (url: string): boolean => {
    try {
      return new URL(url, window.location.origin).origin === window.location.origin;
    } catch {
      return false;
    }
  };

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented) {
      return;
    }
    if (disabled) {
      e.preventDefault();
      return;
    }
    // Let browser handle modifier+click (new tab, etc.)
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    // Let browser handle non-self targets (e.g. target="_blank")
    if (anchorProps.target && anchorProps.target !== "_self") {
      return;
    }
    // Let browser handle external links
    if (!isInternal(href)) {
      return;
    }
    e.preventDefault();
    // When there is no RouterProvider, fall back to a full-page navigation so
    // the link is still functional (e.g. in storybooks or third-party pages).
    if (typeof window !== "undefined" && router.navigate === SSR_FALLBACK_ROUTER.navigate) {
      window.location.href = href;
      return;
    }
    // navigate() expects the logical href (no basePath prefix).
    router.navigate(logicalHref, { replace, resetScroll: resetScroll ?? true });
  };

  const handleMouseEnter = (e: React.MouseEvent<HTMLAnchorElement>) => {
    onMouseEnter?.(e);
    if (!disabled && effectivePreload === "intent" && isInternal(href)) {
      intentTimerRef.current = setTimeout(triggerPrefetch, effectiveDelay);
    }
  };

  const handleMouseLeave = (e: React.MouseEvent<HTMLAnchorElement>) => {
    onMouseLeave?.(e);
    if (intentTimerRef.current !== null) {
      clearTimeout(intentTimerRef.current);
      intentTimerRef.current = null;
    }
  };

  const handleFocus = (e: React.FocusEvent<HTMLAnchorElement>) => {
    onFocus?.(e);
    if (!disabled && effectivePreload === "intent" && isInternal(href)) {
      triggerPrefetch();
    }
  };

  return createElement(
    "a",
    {
      ref: anchorRef,
      href,
      "data-furin-link": true,
      onClick: handleClick,
      onMouseEnter: handleMouseEnter,
      onMouseLeave: handleMouseLeave,
      onFocus: handleFocus,
      ...(isActive ? { "data-status": "active" } : {}),
      ...anchorProps,
      ...extraProps,
      ...(disabled ? { "aria-disabled": true } : {}),
    },
    resolvedChildren
  );
}

// ── SSR fallback router ────────────────────────────────────────────────────────

/**
 * Static fallback used by Link during SSR when there is no RouterProvider.
 * Must not reference `window` — this object is created at module parse time.
 */
/** @internal Exported for unit testing only. */
export const SSR_FALLBACK_ROUTER: RouterContextValue = {
  basePath: "",
  currentHref: "/",
  navigate: () => Promise.resolve(),
  prefetch: () => {
    /* noop */
  },
  invalidatePrefetch: () => {
    /* noop */
  },
  refresh: () => Promise.resolve(),
  isNavigating: false,
  defaultPreload: "intent",
  defaultPreloadDelay: 50,
  defaultPreloadStaleTime: 30_000,
};

/**
 * Pure render helper — no hooks, safe to call from any context including SSR.
 * Computes href, active state, and applies activeProps / inactiveProps before
 * returning the final `<a>` element.
 */
function renderLinkElement<To extends RouteTo>(
  props: LinkProps<To>,
  router: RouterContextValue
): React.ReactElement {
  const { href, isActive, resolvedChildren, extraProps } = computeLinkView(props, router);

  // Destructure to strip Link-specific and client-only props before spreading onto <a>.
  const {
    to: _to,
    search: _search,
    hash: _hash,
    children: _children,
    activeProps: _ap,
    inactiveProps: _ip,
    disabled,
    preload: _p,
    preloadDelay: _pd,
    preloadStaleTime: _ps,
    replace: _r,
    resetScroll: _rs,
    onClick: _oc,
    onMouseEnter: _ome,
    onMouseLeave: _oml,
    onFocus: _of,
    // @ts-expect-error: defensive strip of accidental href prop passed via spread
    href: _href,
    ...anchorProps
  } = props;

  return createElement(
    "a",
    {
      href,
      "data-furin-link": true,
      ...(isActive ? { "data-status": "active" } : {}),
      ...anchorProps,
      ...extraProps,
      ...(disabled ? { "aria-disabled": true } : {}),
    },
    resolvedChildren
  );
}

/**
 * SSR-aware Link component.
 *
 * - **Server (SSR):** uses `RouterContext.Consumer` (a render-prop, not a hook)
 *   to read basePath / currentHref from any enclosing RouterProvider, then
 *   falls back to `SSR_FALLBACK_ROUTER` when no provider is present.
 *   `Context.Consumer` bypasses `ReactCurrentDispatcher` entirely, so it is
 *   safe even when two React instances coexist in the module graph (Bun HMR).
 * - **Client:** delegates to `LinkInteractive` which adds preloading, SPA
 *   navigation, active-state tracking and all other interactive features.
 */
export function Link<To extends RouteTo>(props: LinkProps<To>): React.ReactElement {
  if (typeof window === "undefined") {
    // Use Context.Consumer instead of useContext — the Consumer is processed
    // by react-dom/server directly (no dispatcher lookup), so it works even
    // when link.tsx is loaded under a second React instance via the
    // furin-dev-page virtual namespace after a Bun HMR reload.
    return createElement(RouterContext.Consumer, {
      // biome-ignore lint/correctness/noChildrenProp: render-prop pattern requires children-as-function
      children: (routerCtx: RouterContextValue | null) =>
        renderLinkElement(props, routerCtx ?? SSR_FALLBACK_ROUTER),
    });
  }

  // ── Client rendering ──────────────────────────────────────────────────────
  return createElement(
    LinkInteractive as React.ComponentType<LinkProps<RouteTo>>,
    props as LinkProps<RouteTo>
  );
}

// ── Deferred hydration helpers ─────────────────────────────────────────────────
// Re-exported here so generated `_hydrate.tsx` files can import from
// `@teyik0/furin/link` (already a client-only bundle entry) without requiring
// apps to add "seroval" as a direct dependency.
export { fromCrossJSON } from "seroval";
