/*
  biome-ignore-all lint/complexity/noBannedTypes: The fundamental problem is that
  `Record<string, unknown>` requires an index signature, and any type without one
  (like `{}`, `object`, or a named interface) won't satisfy it. But `{}` is the only type that:
  1. Satisfies `Record<string, unknown>` as a generic default (TS special-cases `{}`)
  2. Doesn't have an index signature (so unknown prop access errors)
  3. Is transparent in intersections(`{} & T = T`)
*/
/*
  biome-ignore-all lint/performance/noBarrelFile: client.ts is the canonical DX
  entry for furin/client consumers, not a generic internal barrel.
*/

import type { Cookie, StatusMap } from "elysia";
import type { AnySchema, HTTPHeaders, UnwrapSchema } from "elysia/types";
import type { RequestLogger } from "evlog";

export {
  type SyncMutation,
  type SyncMutationContext,
  type SyncMutationErrorContext,
  type SyncMutationHeaders,
  type SyncMutationOptions,
  type SyncMutationRunner,
  type SyncMutationSuccessContext,
  type UseSyncOptions,
  useSync,
} from "./client/sync.ts";
export { Await, useAsyncError, useAsyncValue } from "./shared/await.tsx";

declare const UNSET: unique symbol;
type Unset = typeof UNSET;

// Expands interfaces into plain mapped types so they satisfy Record<string, unknown>.
// Interfaces lack an implicit index signature; mapped types have one.
type ToRecord<T> = { [K in keyof T]: T[K] };

type ResolvedSchema<T> = [T] extends [Unset]
  ? Unset
  : T extends AnySchema
    ? UnwrapSchema<T>
    : Unset;

type MergeSchema<TParent, TOwn> = [TParent] extends [Unset]
  ? TOwn
  : [TOwn] extends [Unset]
    ? TParent
    : TParent & TOwn;

type NormalizeUnset<T> = [T] extends [Unset] ? {} : T;
type RequestDataProp<T extends object> = keyof T extends never ? {} : { requestData: Promise<T> };

/**
 * Transforms each key of a parent-data record into an individual `Promise<T>`.
 * This is what child loaders see for inherited fields — direct values from
 * `RouteContext` (request, params, set, …) remain unchanged.
 *
 * `Awaited<T[K]>` mirrors the JS Promise-chaining auto-flatten used by
 * `createLoaderCtx`: when an ancestor wrapped a field with `defer()` (so the
 * raw value is itself a `Promise<U>`), the type collapses to `Promise<U>`
 * instead of `Promise<Promise<U>>`. Otherwise TypeScript would force a
 * redundant `await await ctx.field` dance.
 */
type PromisifyData<T extends Record<string, unknown>> = {
  [K in keyof T]: Promise<Awaited<T[K]>>;
};

export interface RouteContext<TParams = {}, TQuery = {}> {
  cookie: Record<string, Cookie<unknown>>;
  headers: Record<string, string | undefined>;
  /** Request-scoped logger. Call `log.set({})` to attach fields to the wide event for this render. */
  log: RequestLogger;
  params: NormalizeUnset<TParams>;
  path: string;
  query: NormalizeUnset<TQuery>;
  redirect: (url: string, status?: 301 | 302 | 303 | 307 | 308) => Response;
  request: Request;
  set: {
    headers: HTTPHeaders;
    status?: number | keyof StatusMap;
  };
}

export interface RequestCookies {
  get(name: string): unknown;
}

export interface RequestHeaders {
  entries(): IterableIterator<[string, string]>;
  get(name: string): string | null;
  has(name: string): boolean;
}

export interface RequestLoaderContext<TParams = {}, TQuery = {}> {
  readonly cookies: RequestCookies;
  readonly headers: RequestHeaders;
  readonly log: RequestLogger;
  readonly params: NormalizeUnset<TParams>;
  readonly path: string;
  readonly query: NormalizeUnset<TQuery>;
  readonly request: Request;
}

export interface ComponentProps<TParams = {}, TQuery = {}> {
  params: NormalizeUnset<TParams>;
  path: string;
  query: NormalizeUnset<TQuery>;
}

type ResolveParent<T> =
  T extends RouteRef<infer D, infer P, infer Q, infer R>
    ? { data: D; params: P; query: Q; requestData: R }
    : { data: {}; params: Unset; query: Unset; requestData: {} };

interface Resolved<
  TParentRef,
  TLoaderData,
  TParamsSchema = Unset,
  TQuerySchema = Unset,
  TRequestLoaderData extends object = {},
> {
  // `Omit<TLoaderData, "__isDeferred">` strips the runtime brand that `defer()`
  // attaches to its return value. A layout/route loader wrapped with `defer()`
  // would otherwise leak `__isDeferred: true` into descendant loader contexts
  // and component props.
  data: ToRecord<ResolveParent<TParentRef>["data"] & Omit<TLoaderData, "__isDeferred">>;
  params: MergeSchema<ResolveParent<TParentRef>["params"], ResolvedSchema<TParamsSchema>>;
  query: MergeSchema<ResolveParent<TParentRef>["query"], ResolvedSchema<TQuerySchema>>;
  requestData: ToRecord<ResolveParent<TParentRef>["requestData"] & TRequestLoaderData>;
}

export type MetaDescriptor =
  | { charSet: "utf-8" }
  | { title: string }
  | { name: string; content: string }
  | { property: string; content: string }
  | { httpEquiv: string; content: string }
  | { "script:ld+json": object }
  | { tagName: "meta" | "link"; [name: string]: string | undefined };

export interface HeadOptions {
  links?: Array<{ rel: string; href: string; [key: string]: string }>;
  meta?: MetaDescriptor[];
  /**
   * Inline scripts injected into `<head>`.
   *
   * **Security warning:** `children` is injected as raw HTML — never pass
   * user-controlled or loader-derived data here without sanitisation.
   */
  scripts?: Array<{
    src?: string;
    type?: string;
    children?: string;
    [key: string]: string | undefined;
  }>;
  /**
   * Inline styles injected into `<head>`.
   *
   * **Security warning:** `children` is injected as raw HTML — never pass
   * user-controlled or loader-derived data here without sanitisation.
   */
  styles?: Array<{ type?: string; children: string }>;
}

// Extracts the resolved return type from a loader function type.
// Using ReturnType + Awaited here means TLoader is inferred as the whole function
// first, and then we extract the data — so inference is order-independent.
// The `__isDeferred` key (DEFERRED_BRAND, see below) is stripped: a `defer()`
// return carries that runtime marker, but it must never surface as a
// component / head() prop — it is an internal implementation detail.
type ExtractLoaderReturn<TLoader> = TLoader extends (...args: never[]) => unknown
  ? Awaited<ReturnType<TLoader>> extends object
    ? ToRecord<Omit<Awaited<ReturnType<TLoader>>, "__isDeferred">>
    : {}
  : {};

export interface PageConfig<
  TParentData extends Record<string, unknown>,
  TParams,
  TQuery,
  TPageLoaderData extends object = {},
> {
  component: React.FC<TParentData & TPageLoaderData & ComponentProps<TParams, TQuery>>;
  head?: (ctx: ComponentProps<TParams, TQuery> & TParentData & TPageLoaderData) => HeadOptions;
  loader?: (
    ctx: RouteContext<TParams, TQuery> & PromisifyData<TParentData>
  ) => Promise<TPageLoaderData> | TPageLoaderData;
  staticParams?: () => Promise<NormalizeUnset<TParams>[]> | NormalizeUnset<TParams>[];
  tags?: string[];
}

export interface RuntimeRoute {
  __type: "FURIN_ROUTE";
  layout?: React.FC<Record<string, unknown> & { children: React.ReactNode }>;
  loader?(ctx: Record<string, unknown>): Promise<Record<string, unknown>> | Record<string, unknown>;
  mode?: "ssr" | "ssg" | "isr";
  params?: unknown;
  parent?: RuntimeRoute;
  query?: unknown;
  requestLoader?(ctx: RequestLoaderContext): Promise<object> | object;
  revalidate?: number;
  tags?: string[];
}

export interface RuntimePage {
  __type: "FURIN_PAGE";
  _route: RuntimeRoute;
  component: React.FC<Record<string, unknown>>;
  head?(ctx: Record<string, unknown>): HeadOptions;
  loader?(ctx: Record<string, unknown>): Promise<Record<string, unknown>> | Record<string, unknown>;
  requestLoader?(ctx: RequestLoaderContext): Promise<object> | object;
  staticParams?(): Promise<Record<string, string>[]> | Record<string, string>[];
  tags?: string[];
}

export interface RouteRef<
  TData extends Record<string, unknown> = Record<string, unknown>,
  TParams = unknown,
  TQuery = unknown,
  TRequestData extends object = {},
> {
  readonly __brand: "FURIN_ROUTE_REF";
  readonly __phantom: { data: TData; params: TParams; query: TQuery; requestData: TRequestData };
}

interface PageResult<
  TData extends Record<string, unknown>,
  TParams,
  TQuery,
  TPageLoaderData extends object,
  TRequestData extends object,
> {
  __type: "FURIN_PAGE";
  _route: Route<TData, TParams, TQuery>;
  component: React.FC<
    TData & TPageLoaderData & RequestDataProp<TRequestData> & ComponentProps<TParams, TQuery>
  >;
  head?: (ctx: ComponentProps<TParams, TQuery> & TData & TPageLoaderData) => HeadOptions;
  loader?: (
    ctx: RouteContext<TParams, TQuery> & PromisifyData<TData>
  ) => Promise<TPageLoaderData> | TPageLoaderData;
  tags?: string[];
}

export interface Route<
  TParentData extends Record<string, unknown>,
  TParams,
  TQuery,
  TRequestData extends object = {},
> {
  __type: "FURIN_ROUTE";
  layout?: React.FC<
    TParentData &
      RequestDataProp<TRequestData> & { children: React.ReactNode } & ComponentProps<
        TParams,
        TQuery
      >
  >;
  loader?(
    ctx: RouteContext<TParams, TQuery> & PromisifyData<TParentData>
  ): Promise<TParentData> | TParentData;
  mode?: "ssr" | "ssg" | "isr";

  // Overload 1 — loader present (required).
  // Two type params: TLoader is inferred solely from the `loader` position; TPageLoaderData
  // has no inference sites (all NoInfer) so TypeScript applies its default AFTER TLoader is
  // resolved — making declaration order of head/component irrelevant.
  page<
    TLoader extends (ctx: RouteContext<TParams, TQuery> & PromisifyData<TParentData>) => unknown,
    TPageLoaderData extends object = ExtractLoaderReturn<TLoader>,
  >(config: {
    loader: TLoader;
    mode?: "ssr" | "ssg" | "isr";
    revalidate?: number;
    staticParams?: () => Promise<NormalizeUnset<TParams>[]> | NormalizeUnset<TParams>[];
    tags?: string[];
    component: React.FC<
      NoInfer<
        TParentData &
          TPageLoaderData &
          RequestDataProp<TRequestData> &
          ComponentProps<TParams, TQuery>
      >
    >;
    head?: (
      ctx: NoInfer<ComponentProps<TParams, TQuery> & TParentData & TPageLoaderData>
    ) => HeadOptions;
  }): PageResult<TParentData, TParams, TQuery, TPageLoaderData, TRequestData>;

  // Overload 2 — no loader.
  page(config: {
    mode?: "ssr" | "ssg" | "isr";
    revalidate?: number;
    staticParams?: () => Promise<NormalizeUnset<TParams>[]> | NormalizeUnset<TParams>[];
    tags?: string[];
    component: React.FC<
      TParentData & RequestDataProp<TRequestData> & ComponentProps<TParams, TQuery>
    >;
    head?: (ctx: ComponentProps<TParams, TQuery> & TParentData) => HeadOptions;
  }): PageResult<TParentData, TParams, TQuery, {}, TRequestData>;

  params?: unknown;
  parent?: RuntimeRoute;
  query?: unknown;

  /** Branded ref for type inference when used as a parent. */
  ref: RouteRef<TParentData, TParams, TQuery, TRequestData>;
  requestLoader?(ctx: RequestLoaderContext<TParams, TQuery>): Promise<TRequestData> | TRequestData;
  revalidate?: number;
  tags?: string[];
}

export function createRoute<
  TParentRef extends RouteRef | undefined = undefined,
  TParamsSchema extends AnySchema | Unset = Unset,
  TQuerySchema extends AnySchema | Unset = Unset,
  TLoaderData extends object = {},
  TRequestLoaderData extends object = {},
>(config?: {
  parent?: { ref: TParentRef } & { __type: "FURIN_ROUTE" };
  mode?: "ssr" | "ssg" | "isr";
  revalidate?: number;
  params?: TParamsSchema;
  query?: TQuerySchema;
  tags?: string[];
  loader?: (
    ctx: RouteContext<
      Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema>["params"],
      Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema>["query"]
    > &
      PromisifyData<ResolveParent<TParentRef>["data"]>
  ) => Promise<TLoaderData> | TLoaderData;
  requestLoader?: (
    ctx: RequestLoaderContext<
      Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema, TRequestLoaderData>["params"],
      Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema, TRequestLoaderData>["query"]
    >
  ) => Promise<TRequestLoaderData> | TRequestLoaderData;
  layout?: React.FC<
    Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema, TRequestLoaderData>["data"] &
      RequestDataProp<
        Resolved<
          TParentRef,
          TLoaderData,
          TParamsSchema,
          TQuerySchema,
          TRequestLoaderData
        >["requestData"]
      > & {
        children: React.ReactNode;
      } & ComponentProps<
        Resolved<
          TParentRef,
          TLoaderData,
          TParamsSchema,
          TQuerySchema,
          TRequestLoaderData
        >["params"],
        Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema, TRequestLoaderData>["query"]
      >
  >;
}): Route<
  Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema, TRequestLoaderData>["data"],
  Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema, TRequestLoaderData>["params"],
  Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema, TRequestLoaderData>["query"],
  Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema, TRequestLoaderData>["requestData"]
> {
  type R = Resolved<TParentRef, TLoaderData, TParamsSchema, TQuerySchema, TRequestLoaderData>;

  const route = {
    ...config,
    __type: "FURIN_ROUTE" as const,
    ref: {} as RouteRef<R["data"], R["params"], R["query"], R["requestData"]>,

    // biome-ignore lint/suspicious/noExplicitAny: implementation signature for both overloads
    page(pageConfig: any) {
      return {
        ...pageConfig,
        __type: "FURIN_PAGE" as const,
        _route: route,
      };
    },
  };
  return route as Route<R["data"], R["params"], R["query"], R["requestData"]>;
}

export type InferProps<T> = T extends {
  __type: "FURIN_PAGE";
  component: React.FC<infer P>;
}
  ? P
  : T extends Route<infer D, infer P, infer Q, infer R>
    ? D & RequestDataProp<R> & { children: React.ReactNode } & ComponentProps<P, Q>
    : never;

// ── Deferred data ──────────────────────────────────────────────────────────────

/**
 * Brand key that marks an object as deferred. Using a `const` string avoids
 * a `unique symbol` that would complicate cross-module inference.
 */
const DEFERRED_BRAND = "__isDeferred" as const;

/**
 * A loader return value that contains a mix of synchronous scalar fields and
 * lazy `Promise<T>` fields. Scalar fields are serialised into the initial HTML
 * shell; Promise fields are streamed as late `<script>` resolution chunks.
 *
 * @example
 * loader: () => defer({
 *   title: "My Board",          // synchronous — available immediately
 *   stats: fetchStats(),         // Promise — streamed when it resolves
 * })
 */
export type DeferredData<T extends Record<string, unknown>> = T & {
  readonly [DEFERRED_BRAND]: true;
};

/**
 * Wraps loader data so that Promise-valued fields are streamed lazily while
 * scalar fields are embedded in the initial HTML shell immediately.
 *
 * Use in any loader — page (`route.page({ loader })`) or route/layout
 * (`createRoute({ loader })`). Promise-valued fields are streamed lazily;
 * scalar fields are embedded in the initial HTML shell.
 */
export function defer<T extends Record<string, unknown>>(data: T): DeferredData<T> {
  if (Object.hasOwn(data, DEFERRED_BRAND)) {
    throw new Error(
      `[furin] defer() received an object with a reserved key "${DEFERRED_BRAND}". Rename this field to avoid conflicts with the deferred-data runtime.`
    );
  }
  return { ...data, [DEFERRED_BRAND]: true } as DeferredData<T>;
}

/**
 * Type guard for DeferredData. Used by the render pipeline to distinguish a
 * plain loader return from a deferred one.
 */
export function isDeferred(v: unknown): v is DeferredData<Record<string, unknown>> {
  return (
    typeof v === "object" &&
    v !== null &&
    Object.hasOwn(v, DEFERRED_BRAND) &&
    (v as Record<typeof DEFERRED_BRAND, unknown>)[DEFERRED_BRAND] === true
  );
}
