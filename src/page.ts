import type { Elysia } from "elysia";

export interface LoaderContext {
  params: Record<string, string>;
  query: Record<string, string>;
}

export interface ActionContext<TBody = unknown> {
  params: Record<string, string>;
  query: Record<string, string>;
  body: TBody;
}

// Macro can be a function that returns an Elysia plugin or hooks
export type Macro = (app: Elysia) => Elysia;

export interface LoaderConfig<TData = Record<string, unknown>> {
  macro?: Macro;
  handler: (ctx: LoaderContext) => Promise<TData> | TData;
}

export interface ActionConfig<
  TBody = unknown,
  TResult = Record<string, unknown>,
> {
  body: unknown;
  macro?: Macro;
  handler: (ctx: ActionContext<TBody>) => Promise<TResult> | TResult;
}

export interface PageOptions<
  TLoaderData = Record<string, unknown>,
  TActionBody = unknown,
  TActionResult = Record<string, unknown>,
> {
  // biome-ignore lint/suspicious/noExplicitAny: Elysia schema types are passed through
  query?: any;
  // biome-ignore lint/suspicious/noExplicitAny: Elysia schema types are passed through
  params?: any;
  loader?: LoaderConfig<TLoaderData>;
  action?: ActionConfig<TActionBody, TActionResult>;
  mode?: "ssr" | "ssg" | "isr";
  revalidate?: number;
  head?: () => void;
}

export interface PageModule<TData = Record<string, unknown>> {
  __brand: "elysion-react-page";
  component: React.FC<TData>;
  options?: PageOptions;
}

export function page<
  TData extends Record<string, unknown> = Record<string, unknown>,
>(component: React.FC<TData>, options?: PageOptions<TData>): PageModule<TData> {
  return {
    __brand: "elysion-react-page",
    component,
    options,
  };
}

export function isPageModule(value: unknown): value is PageModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "__brand" in value &&
    (value as { __brand?: string }).__brand === "elysion-react-page"
  );
}
