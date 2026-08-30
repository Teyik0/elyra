// biome-ignore-all lint/suspicious/noUnusedExpressions: expect-type assertions are compile-time only

import { describe, test } from "bun:test";
import type { RouteManifest, RouteSearch } from "@teyik0/furin/link";
import type { useSearch } from "@teyik0/furin/search";
import { expectTypeOf } from "expect-type";

import "@teyik0/furin/routes";

declare const defineRoute: typeof import("../../src/furin.ts").defineRoute;
declare const t: typeof import("elysia").t;

const createGeneratedRoute = () =>
  defineRoute()
    .config({ query: t.Object({ page: t.Number(), tag: t.Optional(t.String()) }) })
    .loader(({ query }) => query)
    .page(({ data }) => data.page);

declare const generatedRoute: ReturnType<typeof createGeneratedRoute>;

declare module "@teyik0/furin/routes" {
  interface RouteMap {
    "/elysia-products": typeof generatedRoute;
  }
}

const assertRouteMapBridge = () => {
  type HasProductsRoute = "/elysia-products" extends keyof RouteManifest ? true : false;

  expectTypeOf<HasProductsRoute>().toEqualTypeOf<true>();
  expectTypeOf<RouteSearch<"/elysia-products">>().toEqualTypeOf<{
    page: number;
    tag?: string;
  }>();
  expectTypeOf<ReturnType<typeof useSearch<"/elysia-products">>[0]>().toEqualTypeOf<{
    page: number;
    tag?: string;
  }>();
};

describe("Elysia RouteMap bridge", () => {
  test("projects generated route keys and query types into client routing", assertRouteMapBridge);
});
