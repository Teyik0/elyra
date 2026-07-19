import { useCallback } from "react";
import {
  findSearchDefaultsForRouteTarget,
  type SearchParamsInput,
} from "../../shared/search-params.ts";
import { useRouter } from "./context.ts";
import { buildHref, navigationHrefPolicy } from "./link-utils.ts";
import type { RouteSearch, RouteTo } from "./types.ts";

export interface NavigateInput<To extends RouteTo> {
  hash?: string;
  replace?: boolean;
  resetScroll?: boolean;
  search?: RouteSearch<To>;
  to: To;
}

export type Navigate = <To extends RouteTo>(next: NavigateInput<To>) => Promise<void>;
type NavigateOptions = Parameters<ReturnType<typeof useRouter>["navigate"]>[1];

export function useNavigate(): Navigate {
  const router = useRouter();

  return useCallback<Navigate>(
    (next) => {
      const searchDefaults = findSearchDefaultsForRouteTarget(
        next.to as string,
        router.searchRoutes
      );
      const href = buildHref(
        next.to as string,
        next.search as SearchParamsInput | null | undefined,
        next.hash,
        searchDefaults
      );
      const policy = navigationHrefPolicy(
        href,
        typeof window === "undefined" ? undefined : window.location.origin
      );
      if (policy === "blocked") {
        return Promise.reject(new Error("[furin] Unsafe navigation URL."));
      }
      if (policy === "external" && typeof window !== "undefined") {
        window.location.assign(href);
        return Promise.resolve();
      }
      const opts: NavigateOptions =
        next.replace === undefined && next.resetScroll === undefined
          ? undefined
          : { replace: next.replace, resetScroll: next.resetScroll };
      return router.navigate(href, opts);
    },
    [router]
  );
}
