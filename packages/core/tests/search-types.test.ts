// biome-ignore-all lint/suspicious/noUnusedExpressions: expect-type assertions are compile-time only

import { describe, test } from "bun:test";
import type { EmptyRouteSearch, useSearch, useSetSearch } from "@teyik0/furin/search";
import { expectTypeOf } from "expect-type";

import "@teyik0/furin/link";

declare module "@teyik0/furin/link" {
  interface RouteManifest {
    "/": { search?: never };
    "/products": { search?: { page: number; tag?: string } };
  }
}

describe("@teyik0/furin/search types", () => {
  test("reads search types from the generated route manifest", () => {
    expectTypeOf<ReturnType<typeof useSearch<"/products">>>().toEqualTypeOf<{
      page: number;
      tag?: string;
    }>();
    expectTypeOf<ReturnType<typeof useSearch<"/">>>().toEqualTypeOf<EmptyRouteSearch>();
  });

  test("types setSearch input from the route manifest", () => {
    type SetProductsSearch = ReturnType<typeof useSetSearch<"/products">>;

    expectTypeOf<SetProductsSearch>().toBeCallableWith({ page: 2 });
    expectTypeOf<SetProductsSearch>().toBeCallableWith({ page: 2 }, undefined);
    expectTypeOf<SetProductsSearch>().toBeCallableWith((prev) => ({ page: prev.page + 1 }), {
      replace: true,
    });
    expectTypeOf<SetProductsSearch>().parameter(0).not.toMatchTypeOf<{ missing: true }>();
  });
});
