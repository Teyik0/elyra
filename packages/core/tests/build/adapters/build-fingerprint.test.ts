import { describe, expect, test } from "bun:test";
import { join as joinPath } from "node:path";

const BUILD_FINGERPRINT_SCENARIOS = String.raw`
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBuildFingerprint } from "./src/adapter/bun.ts";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const appDir = mkdtempSync(resolve(tmpdir(), "furin-fingerprint-"));

try {
  const rootPath = join(appDir, "root.tsx");
  const firstRoutePath = join(appDir, "é.tsx");
  const secondRoutePath = join(appDir, "z.tsx");
  writeFileSync(rootPath, "root");
  writeFileSync(firstRoutePath, "first");
  writeFileSync(secondRoutePath, "second");

  const root = {
    path: rootPath,
    route: {},
  };
  const routes = [
    {
      mode: "ssr",
      page: {},
      path: firstRoutePath,
      pattern: "/é",
      routeChain: [],
      segmentBoundaries: [],
    },
    {
      mode: "ssr",
      page: {},
      path: secondRoutePath,
      pattern: "/z",
      routeChain: [],
      segmentBoundaries: [],
    },
  ];

  const fingerprint = await createBuildFingerprint("entry.js", [], routes, root, null);
  const zRouteIndex = fingerprint.indexOf('"pattern":"/z"');
  const accentedRouteIndex = fingerprint.indexOf('"pattern":"/é"');

  assert(zRouteIndex > -1, "fingerprint should include /z route");
  assert(accentedRouteIndex > -1, "fingerprint should include non-ASCII route");
  assert(
    zRouteIndex < accentedRouteIndex,
    "route fingerprint order should use locale-independent code unit sorting"
  );
} finally {
  rmSync(appDir, { force: true, recursive: true });
}

process.exit(0);
`;

describe("createBuildFingerprint", () => {
  test("orders route inputs without locale-sensitive collation", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", BUILD_FINGERPRINT_SCENARIOS],
      cwd: joinPath(import.meta.dir, "../../.."),
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
