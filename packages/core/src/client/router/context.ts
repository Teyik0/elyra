import { createContext, useContext } from "react";
import type { RouterContextValue } from "./types.ts";

export const RouterContext = createContext<RouterContextValue | null>(null);

export const CLIENT_FALLBACK_ROUTER: RouterContextValue = {
  basePath: "",
  // Use the same "/" as SSR_FALLBACK_ROUTER so SSR and client render the
  // same active-state when no RouterProvider is present, avoiding hydration mismatches.
  currentHref: "/",
  search: {},
  navigate: (href, _opts) => {
    window.location.href = href;
    return Promise.resolve();
  },
  prefetch: (_href, _opts) => {
    /* noop fallback */
  },
  invalidatePrefetch: (_path, _type) => {
    /* noop fallback */
  },
  refresh: (_opts) => {
    window.location.reload();
    return Promise.resolve();
  },
  isNavigating: false,
  defaultPreload: "intent",
  defaultPreloadDelay: 50,
  defaultPreloadStaleTime: 30_000,
};

/**
 * Returns the current router context.
 * Provides a graceful fallback (full-page navigation) when used outside RouterProvider.
 */
export function useRouter(): RouterContextValue {
  const ctx = useContext(RouterContext);
  return ctx ?? CLIENT_FALLBACK_ROUTER;
}
