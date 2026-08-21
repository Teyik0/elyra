import { expect, test } from "bun:test";
// @ts-expect-error — the obsolete page config is not a public contract
import type { PageConfig, RuntimePage, RuntimeRoute } from "../../src/client.ts";

export type InternalTypesAreNotPublic =
  | PageConfig<object, unknown, unknown>
  | RuntimePage
  | RuntimeRoute;

test("the public client entry stays runtime-type free", () => {
  expect(true).toBe(true);
});
