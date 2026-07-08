import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRscGraph } from "../src/rsc/build";
import { environmentGuardPlugin } from "../src/rsc/build/environment";
import { resolveConfiguredCodecPath } from "../src/rsc/codec";
import { assertCompatibleRscVersions } from "../src/rsc/version";

const paths: string[] = [];
const VERSION_MISMATCH_RE = /must match exactly/;

afterEach(() => {
  for (const path of paths.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function buildProtectedImport(graph: "client" | "rsc", specifier: string) {
  const root = mkdtempSync(join(tmpdir(), "furin-rsc-guard-"));
  paths.push(root);
  const entry = join(root, "entry.ts");
  writeFileSync(entry, `import ${JSON.stringify(specifier)};`);
  return Bun.build({
    conditions: graph === "rsc" ? ["react-server"] : undefined,
    entrypoints: [entry],
    outdir: join(root, "out"),
    plugins: [environmentGuardPlugin(graph)],
    target: graph === "client" ? "browser" : "bun",
  });
}

describe("RSC graph environment guards", () => {
  test("emits the Flight codec next to the production server bundle", async () => {
    const root = mkdtempSync(join(tmpdir(), "furin-rsc-build-"));
    paths.push(root);
    const rootEntry = join(root, "root.tsx");
    writeFileSync(rootEntry, "export default function Root() { return null; }");

    await buildRscGraph([], { path: rootEntry, route: {} as never }, root, "test-build", undefined);

    expect(existsSync(join(root, "server-codec.js"))).toBe(true);
  });

  test("uses an explicitly configured prebuilt Flight codec", () => {
    const root = mkdtempSync(join(tmpdir(), "furin-rsc-codec-"));
    paths.push(root);
    const codecPath = join(root, "server-codec.js");
    writeFileSync(codecPath, "export const renderFlight = () => null;");

    expect(resolveConfiguredCodecPath(codecPath)).toBe(codecPath);
  });

  test("rejects mismatched React and Flight codec versions", () => {
    expect(() =>
      assertCompatibleRscVersions({
        react: "19.2.7",
        reactDom: "19.2.7",
        reactServerDom: "19.2.6",
      })
    ).toThrow(VERSION_MISMATCH_RE);
  });

  test("rejects insecure React 19.2.0 prerelease patch variants", () => {
    expect(() =>
      assertCompatibleRscVersions({
        react: "19.2.0-canary-1",
        reactDom: "19.2.0-canary-1",
        reactServerDom: "19.2.0-canary-1",
      })
    ).toThrow("insecure");
  });

  test("rejects server-only modules from the browser graph", async () => {
    await expect(buildProtectedImport("client", "furin/server-only")).rejects.toThrow();
  });

  test("rejects client-only modules from the RSC graph", async () => {
    await expect(buildProtectedImport("rsc", "furin/client-only")).rejects.toThrow();
  });
});
