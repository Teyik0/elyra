import { useCallback } from "react";
import { useRouter } from "../context.ts";
import { buildHref } from "../link-utils.ts";
import type { RouteSearch, RouteTo } from "../types.ts";

// biome-ignore lint/suspicious/noEmptyInterface: intentionally augmentable via furin-env.d.ts
export interface RouteManifest {}

export type SearchRouteTo = keyof RouteManifest extends never
  ? RouteTo
  : (string & {}) | keyof RouteManifest;

type SearchRouteSearch<To extends SearchRouteTo> = keyof RouteManifest extends never
  ? RouteSearch<To & RouteTo>
  : To extends keyof RouteManifest
    ? RouteManifest[To] extends { search?: infer S }
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
      const merged = { ...prev, ...patch } as Record<string, unknown>;
      const href = buildHref(pathnameFromLogicalHref(router.currentHref), merged, undefined);
      return router.navigate(href, { replace: opts?.replace ?? false });
    },
    [router]
  );
}
