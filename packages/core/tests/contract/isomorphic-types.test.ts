import { expect, test } from "bun:test";
import { expectTypeOf } from "expect-type";
import type { createIsomorphicFn as publicCreateIsomorphicFn } from "../../src/furin.ts";
import { createIsomorphicFn } from "../../src/isomorphic.ts";

const publicContract: typeof publicCreateIsomorphicFn = createIsomorphicFn;

test("a server implementation preserves arguments and includes the client no-op", () => {
  const getValue = createIsomorphicFn().server((id: string, count: number) => ({
    count,
    id,
    source: "server" as const,
  }));

  expectTypeOf(getValue).toBeCallableWith("board-1", 2);
  expectTypeOf(getValue("board-1", 2)).toEqualTypeOf<
    { count: number; id: string; source: "server" } | undefined
  >();
  expectTypeOf(publicContract).toEqualTypeOf<typeof createIsomorphicFn>();
  expect(true).toBe(true);
});

test("both chain orders preserve arguments and union branch return types", () => {
  const serverFirst = createIsomorphicFn()
    .server((id: string) => ({ id, source: "server" as const }))
    .client((id) => ({ id, source: "client" as const }));
  const clientFirst = createIsomorphicFn()
    .client((id: string) => id.length)
    .server((id) => id);

  expectTypeOf(serverFirst("board-1")).toEqualTypeOf<
    { id: string; source: "server" } | { id: string; source: "client" }
  >();
  expectTypeOf(clientFirst("board-1")).toEqualTypeOf<number | string>();
  expectTypeOf(serverFirst).not.toHaveProperty("server");
  expectTypeOf(clientFirst).not.toHaveProperty("client");
  expect(true).toBe(true);
});

test("a client-only implementation includes the server no-op", () => {
  const getValue = createIsomorphicFn().client((id: string) => id.length);

  expectTypeOf(getValue("board-1")).toEqualTypeOf<number | undefined>();
  expect(true).toBe(true);
});
