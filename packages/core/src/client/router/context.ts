import { createContext, useContext } from "react";
import type { RouterContextValue } from "./types.ts";

export const RouterContext = createContext<RouterContextValue | null>(null);

/**
 * Returns the current router context.
 * Provides a graceful fallback (full-page navigation) when used outside RouterProvider.
 */
export function useRouter(): RouterContextValue {
  const ctx = useContext(RouterContext);
  return (
    ctx ?? {
      basePath: "",
      // Use the same "/" as SSR_FALLBACK_ROUTER so SSR and client render the
      // same active-state when no RouterProvider is present, avoiding hydration mismatches.
      currentHref: "/",
      navigate: (href) => {
        window.location.href = href;
        return Promise.resolve();
      },
      prefetch: () => {
        /* noop fallback */
      },
      invalidatePrefetch: () => {
        /* noop fallback */
      },
      refresh: () => {
        window.location.reload();
        return Promise.resolve();
      },
      isNavigating: false,
      defaultPreload: "intent",
      defaultPreloadDelay: 50,
      defaultPreloadStaleTime: 30_000,
    }
  );
}
