/**
 * computeErrorDigest — a deterministic, opaque 10-hex-char hash derived from an
 * error's message + stack. Used to correlate client-side error displays with
 * server-side logs without leaking stack traces to the client.
 */
import { describe, expect, test } from "bun:test";
import { computeErrorDigest } from "../src/server/render/digest.ts";

const DIGEST_RE = /^[0-9a-f]{10}$/;

describe("computeErrorDigest", () => {
  test("returns a 10-character lowercase hex string", () => {
    const digest = computeErrorDigest(new Error("boom"));
    expect(digest).toMatch(DIGEST_RE);
  });

  test("is deterministic — identical errors yield identical digests", () => {
    const err1 = new Error("boom");
    err1.stack = "Error: boom\n  at x (/foo:1:1)";
    const err2 = new Error("boom");
    err2.stack = "Error: boom\n  at x (/foo:1:1)";
    expect(computeErrorDigest(err1)).toBe(computeErrorDigest(err2));
  });

  test("different error messages produce different digests", () => {
    const a = computeErrorDigest(new Error("boom"));
    const b = computeErrorDigest(new Error("kaboom"));
    expect(a).not.toBe(b);
  });

  test("different stacks produce different digests even with same message", () => {
    const a = new Error("boom");
    a.stack = "Error: boom\n  at a (/a:1:1)";
    const b = new Error("boom");
    b.stack = "Error: boom\n  at b (/b:1:1)";
    expect(computeErrorDigest(a)).not.toBe(computeErrorDigest(b));
  });

  test("accepts a plain string error", () => {
    const digest = computeErrorDigest("just a string");
    expect(digest).toMatch(DIGEST_RE);
  });

  test("accepts a non-Error non-string value without throwing", () => {
    const digest = computeErrorDigest({ weird: true });
    expect(digest).toMatch(DIGEST_RE);
  });

  test("accepts undefined/null without throwing", () => {
    expect(computeErrorDigest(undefined)).toMatch(DIGEST_RE);
    expect(computeErrorDigest(null)).toMatch(DIGEST_RE);
  });
});
