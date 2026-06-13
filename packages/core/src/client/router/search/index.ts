import type { RouteManifest as LinkRouteManifest, RouteSearch, RouteTo } from "@teyik0/furin/link";
import { useCallback } from "react";
import type { SearchParamsInput } from "../../../shared/search-params.ts";
import { useRouter } from "../context.ts";
import { buildHref } from "../link-utils.ts";

export interface RouteManifest extends LinkRouteManifest {}

export type SearchRouteTo = keyof LinkRouteManifest extends never
  ? RouteTo
  : (string & {}) | keyof LinkRouteManifest;

type SearchRouteSearch<To extends SearchRouteTo> = keyof LinkRouteManifest extends never
  ? RouteSearch<To & RouteTo>
  : To extends keyof LinkRouteManifest
    ? LinkRouteManifest[To] extends { search?: infer S }
      ? S
      : undefined
    : undefined;

export type EmptyRouteSearch = Record<PropertyKey, never>;

export type ResolvedRouteSearch<To extends SearchRouteTo> =
  SearchRouteSearch<To> extends never | undefined
    ? EmptyRouteSearch
    : NonNullable<SearchRouteSearch<To>>;

export function useSearch<To extends SearchRouteTo>(_from: To): ResolvedRouteSearch<To> {
  return useRouter().search as ResolvedRouteSearch<To>;
}

export interface SetSearchOptions {
  replace?: boolean;
}

export type SetSearchInput<To extends SearchRouteTo> =
  | Partial<ResolvedRouteSearch<To>>
  | ((prev: ResolvedRouteSearch<To>) => Partial<ResolvedRouteSearch<To>>);

function pathnameFromLogicalHref(logicalHref: string): string {
  return new URL(logicalHref, "http://furin.local").pathname;
}

export function useSetSearch<To extends SearchRouteTo>(
  _from: To
): (next: SetSearchInput<To>, opts?: SetSearchOptions) => Promise<void> {
  const router = useRouter();

  return useCallback(
    (next: SetSearchInput<To>, opts?: SetSearchOptions) => {
      const prev = router.search as ResolvedRouteSearch<To>;
      const patch = typeof next === "function" ? next(prev) : next;
      const merged = { ...prev, ...patch } as SearchParamsInput;
      const href = buildHref(pathnameFromLogicalHref(router.currentHref), merged, undefined);
      return router.navigate(href, { replace: opts?.replace ?? false });
    },
    [router]
  );
}
