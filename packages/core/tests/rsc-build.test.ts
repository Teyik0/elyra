import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { environmentGuardPlugin } from "../src/rsc/build/environment";
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
    entrypoints: [entry],
    outdir: join(root, "out"),
    target: graph === "client" ? "browser" : "bun",
    conditions: graph === "rsc" ? ["react-server"] : undefined,
    plugins: [environmentGuardPlugin(graph)],
  });
}

describe("RSC graph environment guards", () => {
  test("rejects mismatched React and Flight codec versions", () => {
    expect(() =>
      assertCompatibleRscVersions({
        react: "19.2.7",
        reactDom: "19.2.7",
        reactServerDom: "19.2.6",
      })
    ).toThrow(VERSION_MISMATCH_RE);
  });

  test("rejects server-only modules from the browser graph", async () => {
    await expect(buildProtectedImport("client", "furin/server-only")).rejects.toThrow();
  });

  test("rejects client-only modules from the RSC graph", async () => {
    await expect(buildProtectedImport("rsc", "furin/client-only")).rejects.toThrow();
  });
});
