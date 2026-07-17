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

export type RenderingMode = "ssr" | "ssg" | "isr";

const DEFERRED_BRAND: unique symbol = Symbol.for("@teyik0/furin/deferred");
declare const ROUTE_TYPES: unique symbol;

type NoFields = NonNullable<unknown>;
type Awaitable<T> = Promise<T> | T;
type StaticParams<TParams> = () => Awaitable<readonly TParams[]>;
type StripDeferred<T> = Omit<T, typeof DEFERRED_BRAND>;

type ResolvedSchema<T> = T extends AnySchema ? UnwrapSchema<T> : NoFields;
type RequestDataProp<T extends object> = keyof T extends never
  ? NoFields
  : { requestData: Promise<T> };

interface RouteTypeInfo<
  TData extends object = object,
  TParams = unknown,
  TQuery = unknown,
  TRequestData extends object = NoFields,
> {
  data: TData;
  params: TParams;
  query: TQuery;
  requestData: TRequestData;
}

interface RouteCarrier {
  readonly __type: "FURIN_ROUTE";
  readonly [ROUTE_TYPES]: RouteTypeInfo;
}

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
type PromisifyData<T extends object> = {
  [K in keyof T]: Promise<Awaited<T[K]>>;
};

export interface RouteContext<TParams = NoFields, TQuery = NoFields> {
  cookie: Record<string, Cookie<unknown>>;
  headers: Record<string, string | undefined>;
  /** Request-scoped logger. Call `log.set({})` to attach fields to the wide event for this render. */
  log: RequestLogger;
  params: TParams;
  path: string;
  query: TQuery;
  redirect: (url: string, status?: 301 | 302 | 303 | 307 | 308) => Response;
  request: Request;
  set: {
    headers: HTTPHeaders;
    status?: number | keyof StatusMap;
  };
}

export interface RequestCookies {
  get: (name: string) => unknown;
}

export interface RequestHeaders {
  entries: () => IterableIterator<[string, string]>;
  get: (name: string) => string | null;
  has: (name: string) => boolean;
}

export interface RequestLoaderContext<TParams = NoFields, TQuery = NoFields> {
  readonly cookies: RequestCookies;
  readonly headers: RequestHeaders;
  readonly log: RequestLogger;
  readonly params: TParams;
  readonly path: string;
  readonly query: TQuery;
  readonly request: Request;
}

export interface ComponentProps<TParams = NoFields, TQuery = NoFields> {
  params: TParams;
  path: string;
  query: TQuery;
}

type ResolveParent<T> = T extends {
  readonly [ROUTE_TYPES]: RouteTypeInfo<infer D, infer P, infer Q, infer R>;
}
  ? { data: D; params: P; query: Q; requestData: R }
  : { data: NoFields; params: NoFields; query: NoFields; requestData: NoFields };

interface Resolved<
  TParentRoute,
  TLoaderData,
  TParamsSchema = undefined,
  TQuerySchema = undefined,
  TRequestLoaderData extends object = NoFields,
> {
  // `StripDeferred<TLoaderData>` strips the internal brand that `defer()`
  // attaches to its return value. A layout/route loader wrapped with `defer()`
  // would otherwise leak deferred metadata into descendant loader contexts
  // and component props.
  data: ResolveParent<TParentRoute>["data"] & StripDeferred<TLoaderData>;
  params: ResolveParent<TParentRoute>["params"] & ResolvedSchema<TParamsSchema>;
  query: ResolveParent<TParentRoute>["query"] & ResolvedSchema<TQuerySchema>;
  requestData: ResolveParent<TParentRoute>["requestData"] & TRequestLoaderData;
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
// The deferred marker is stripped: a `defer()` return carries it internally,
// but it must never surface as a
// component / head() prop — it is an internal implementation detail.
type ExtractLoaderReturn<TLoader> = TLoader extends (...args: never[]) => unknown
  ? Awaited<ReturnType<TLoader>> extends object
    ? StripDeferred<Awaited<ReturnType<TLoader>>>
    : NoFields
  : NoFields;

interface PageResult<
  TData extends object,
  TParams,
  TQuery,
  TPageLoaderData extends object,
  TRequestData extends object,
> {
  __type: "FURIN_PAGE";
  _route: Route<TData, TParams, TQuery, TRequestData>;
  component: React.FC<
    TData & TPageLoaderData & RequestDataProp<TRequestData> & ComponentProps<TParams, TQuery>
  >;
  head?: (ctx: ComponentProps<TParams, TQuery> & TData & TPageLoaderData) => HeadOptions;
  loader?: (
    ctx: RouteContext<TParams, TQuery> & PromisifyData<TData>
  ) => Awaitable<TPageLoaderData>;
  mode?: RenderingMode;
  revalidate?: number;
  staticParams?: StaticParams<TParams>;
  tags?: readonly string[];
}

export interface Route<
  TParentData extends object,
  TParams,
  TQuery,
  TRequestData extends object = NoFields,
> {
  __type: "FURIN_ROUTE";
  layout?: React.FC<
    TParentData &
      RequestDataProp<TRequestData> & { children: React.ReactNode } & ComponentProps<
        TParams,
        TQuery
      >
  >;
  loader?: (
    ctx: RouteContext<TParams, TQuery> & PromisifyData<TParentData>
  ) => Awaitable<TParentData>;
  mode?: RenderingMode;

  // Overload 1 — loader present (required).
  // Two type params: TLoader is inferred solely from the `loader` position; TPageLoaderData
  // has no inference sites (all NoInfer) so TypeScript applies its default AFTER TLoader is
  // resolved — making declaration order of head/component irrelevant.
  page: {
    <
      TLoader extends (ctx: RouteContext<TParams, TQuery> & PromisifyData<TParentData>) => unknown,
      TPageLoaderData extends object = ExtractLoaderReturn<TLoader>,
    >(config: {
      loader: TLoader;
      mode?: RenderingMode;
      revalidate?: number;
      staticParams?: StaticParams<TParams>;
      tags?: readonly string[];
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
    (config: {
      mode?: RenderingMode;
      revalidate?: number;
      staticParams?: StaticParams<TParams>;
      tags?: readonly string[];
      component: React.FC<
        TParentData & RequestDataProp<TRequestData> & ComponentProps<TParams, TQuery>
      >;
      head?: (ctx: ComponentProps<TParams, TQuery> & TParentData) => HeadOptions;
    }): PageResult<TParentData, TParams, TQuery, NoFields, TRequestData>;
  };

  params?: unknown;
  parent?: RouteCarrier;
  query?: unknown;

  requestLoader?: (ctx: RequestLoaderContext<TParams, TQuery>) => Awaitable<TRequestData>;
  revalidate?: number;
  tags?: readonly string[];
  readonly [ROUTE_TYPES]: RouteTypeInfo<TParentData, TParams, TQuery, TRequestData>;
}

export function createRoute<
  TParentRoute extends RouteCarrier | undefined = undefined,
  TParamsSchema extends AnySchema | undefined = undefined,
  TQuerySchema extends AnySchema | undefined = undefined,
  TLoaderData extends object = NoFields,
  TRequestLoaderData extends object = NoFields,
>(config?: {
  parent?: TParentRoute;
  mode?: RenderingMode;
  revalidate?: number;
  params?: TParamsSchema;
  query?: TQuerySchema;
  tags?: readonly string[];
  loader?: (
    ctx: RouteContext<
      Resolved<TParentRoute, TLoaderData, TParamsSchema, TQuerySchema>["params"],
      Resolved<TParentRoute, TLoaderData, TParamsSchema, TQuerySchema>["query"]
    > &
      PromisifyData<ResolveParent<TParentRoute>["data"]>
  ) => Awaitable<TLoaderData>;
  requestLoader?: (
    ctx: RequestLoaderContext<
      Resolved<
        TParentRoute,
        TLoaderData,
        TParamsSchema,
        TQuerySchema,
        TRequestLoaderData
      >["params"],
      Resolved<TParentRoute, TLoaderData, TParamsSchema, TQuerySchema, TRequestLoaderData>["query"]
    >
  ) => Awaitable<TRequestLoaderData>;
  layout?: React.FC<
    Resolved<TParentRoute, TLoaderData, TParamsSchema, TQuerySchema, TRequestLoaderData>["data"] &
      RequestDataProp<
        Resolved<
          TParentRoute,
          TLoaderData,
          TParamsSchema,
          TQuerySchema,
          TRequestLoaderData
        >["requestData"]
      > & {
        children: React.ReactNode;
      } & ComponentProps<
        Resolved<
          TParentRoute,
          TLoaderData,
          TParamsSchema,
          TQuerySchema,
          TRequestLoaderData
        >["params"],
        Resolved<
          TParentRoute,
          TLoaderData,
          TParamsSchema,
          TQuerySchema,
          TRequestLoaderData
        >["query"]
      >
  >;
}): Route<
  Resolved<TParentRoute, TLoaderData, TParamsSchema, TQuerySchema, TRequestLoaderData>["data"],
  Resolved<TParentRoute, TLoaderData, TParamsSchema, TQuerySchema, TRequestLoaderData>["params"],
  Resolved<TParentRoute, TLoaderData, TParamsSchema, TQuerySchema, TRequestLoaderData>["query"],
  Resolved<
    TParentRoute,
    TLoaderData,
    TParamsSchema,
    TQuerySchema,
    TRequestLoaderData
  >["requestData"]
> {
  type R = Resolved<TParentRoute, TLoaderData, TParamsSchema, TQuerySchema, TRequestLoaderData>;

  const route = {
    ...config,
    __type: "FURIN_ROUTE" as const,

    page<TPageConfig extends object>(pageConfig: TPageConfig) {
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
export type DeferredData<T extends object> = T & {
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
export function defer<T extends object>(
  data: T & { readonly [DEFERRED_BRAND]?: never }
): DeferredData<T> {
  if (Object.hasOwn(data, DEFERRED_BRAND)) {
    throw new Error("[furin] defer() received data that is already deferred.");
  }
  return { ...data, [DEFERRED_BRAND]: true };
}

/**
 * Type guard for DeferredData. Used by the render pipeline to distinguish a
 * plain loader return from a deferred one.
 */
export function isDeferred(value: unknown): value is DeferredData<object> {
  return (
    typeof value === "object" &&
    value !== null &&
    DEFERRED_BRAND in value &&
    Object.hasOwn(value, DEFERRED_BRAND) &&
    value[DEFERRED_BRAND] === true
  );
}
