import { expect, test } from "bun:test";
import type { Context } from "elysia";
import { mergeStoredResponseHeaders } from "../../../src/server/sync/response.ts";

test("replay header overrides preserve every configured value", () => {
  const merged = mergeStoredResponseHeaders(
    { body: new Uint8Array(), headers: [["x-furin-tag", "stale"]], status: 200 },
    {
      "x-furin-tag": ["alpha", "beta"],
    } as unknown as Context["set"]["headers"]
  );

  const headers = new Headers(
    merged.headers.map(([name, value]) => [name, value] as [string, string])
  );
  expect(headers.get("x-furin-tag")).toBe("alpha, beta");
});

test("replay header overrides discard configured cookies", () => {
  const merged = mergeStoredResponseHeaders(
    { body: new Uint8Array(), headers: [["set-cookie", "old=1"]], status: 200 },
    {
      "set-cookie": ["session=alpha; Path=/", "theme=dark; Path=/"],
    } as Context["set"]["headers"]
  );

  const headers = new Headers(
    merged.headers.map(([name, value]) => [name, value] as [string, string])
  );
  expect(headers.getSetCookie()).toEqual([]);
});
