import { useCallback } from "react";
import { findSearchDefaults, type SearchParamsInput } from "../../shared/search-params.ts";
import { useRouter } from "./context.ts";
import { buildHref } from "./link-utils.ts";
import type { RouterContextValue, RouteSearch, RouteTo } from "./types.ts";

export interface NavigateInput<To extends RouteTo> {
  hash?: string;
  search?: RouteSearch<To>;
  to: To;
}

export type Navigate = <To extends RouteTo>(next: NavigateInput<To>) => Promise<void>;

function findSearchDefaultsForTo(
  to: string,
  router: RouterContextValue
): SearchParamsInput | undefined {
  try {
    const pathname = new URL(to, "http://furin.local").pathname;
    return findSearchDefaults(pathname, router.searchRoutes ?? []);
  } catch {
    return;
  }
}

export function useNavigate(): Navigate {
  const router = useRouter();

  return useCallback<Navigate>(
    (next) => {
      const searchDefaults = findSearchDefaultsForTo(next.to as string, router);
      const href = buildHref(
        next.to as string,
        next.search as SearchParamsInput | null | undefined,
        next.hash,
        searchDefaults
      );
      return router.navigate(href, undefined);
    },
    [router]
  );
}
