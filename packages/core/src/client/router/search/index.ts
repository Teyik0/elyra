import type { RouteManifest as LinkRouteManifest, RouteSearch, RouteTo } from "@teyik0/furin/link";
import { useCallback, useContext, useRef, useSyncExternalStore } from "react";
import { findSearchDefaults, type SearchParamsInput } from "../../../shared/search-params.ts";
import { buildHref } from "../link-utils.ts";
import { FALLBACK_SEARCH_STORE, SearchStoreContext } from "../search-store.ts";

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

export type SetSearchInput<To extends SearchRouteTo> =
  | Partial<ResolvedRouteSearch<To>>
  | ((prev: ResolvedRouteSearch<To>) => Partial<ResolvedRouteSearch<To>>);

export type SetSearch<To extends SearchRouteTo> = (next: SetSearchInput<To>) => Promise<void>;

function pathnameFromLogicalHref(logicalHref: string): string {
  return new URL(logicalHref, "http://furin.local").pathname;
}

function useSearchSelection<To extends SearchRouteTo, TSelected>(
  selector: (search: ResolvedRouteSearch<To>) => TSelected
): TSelected {
  const store = useContext(SearchStoreContext) ?? FALLBACK_SEARCH_STORE;
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  const getSnapshot = useCallback(
    () => selectorRef.current(store.getSnapshot().search as ResolvedRouteSearch<To>),
    [store]
  );
  const getServerSnapshot = useCallback(
    () => selectorRef.current(store.getServerSnapshot().search as ResolvedRouteSearch<To>),
    [store]
  );

  return useSyncExternalStore(store.subscribe, getSnapshot, getServerSnapshot);
}

export function useSearch<To extends SearchRouteTo>(
  _from: To
): [ResolvedRouteSearch<To>, SetSearch<To>];
export function useSearch<To extends SearchRouteTo, TSelected>(
  _from: To,
  selector: (search: ResolvedRouteSearch<To>) => TSelected
): [TSelected, SetSearch<To>];
export function useSearch<To extends SearchRouteTo, TSelected>(
  _from: To,
  selector?: (search: ResolvedRouteSearch<To>) => TSelected
): [ResolvedRouteSearch<To> | TSelected, SetSearch<To>] {
  const store = useContext(SearchStoreContext) ?? FALLBACK_SEARCH_STORE;
  const selected = useSearchSelection<To, ResolvedRouteSearch<To> | TSelected>((search) =>
    selector ? selector(search) : search
  );

  const setSearch = useCallback<SetSearch<To>>(
    (next) => {
      const snapshot = store.getSnapshot();
      const search = snapshot.search as ResolvedRouteSearch<To>;
      const patch = typeof next === "function" ? next(search) : next;
      const merged = { ...search, ...patch } as SearchParamsInput;
      const pathname = pathnameFromLogicalHref(snapshot.currentHref);
      const searchDefaults = findSearchDefaults(pathname, snapshot.searchRoutes);
      const href = buildHref(pathname, merged, undefined, searchDefaults);
      return snapshot.navigate(href, undefined);
    },
    [store]
  );

  return [selected, setSearch];
}
