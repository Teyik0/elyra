import { useCallback } from "react";
import {
  findSearchDefaultsForRouteTarget,
  type SearchParamsInput,
} from "../../shared/search-params.ts";
import { useRouter } from "./context.ts";
import { buildHref } from "./link-utils.ts";
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

function isExternalAbsoluteHref(href: string): boolean {
  if (href.startsWith("//")) {
    return true;
  }
  if (!(href.startsWith("http://") || href.startsWith("https://"))) {
    return false;
  }
  if (typeof window === "undefined") {
    return true;
  }
  return new URL(href).origin !== window.location.origin;
}

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
      if (isExternalAbsoluteHref(href) && typeof window !== "undefined") {
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
