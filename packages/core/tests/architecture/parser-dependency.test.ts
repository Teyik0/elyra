import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface DependencyMap {
  "@babel/parser"?: string;
  "@yuku-toolchain/types"?: string;
  "yuku-parser"?: string;
}

interface PackageManifest {
  dependencies?: DependencyMap;
  devDependencies?: DependencyMap;
}

function readCoreManifest(): PackageManifest {
  const packageJsonPath = join(import.meta.dir, "../../package.json");
  return JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageManifest;
}

describe("architecture: parser dependency", () => {
  test("core uses yuku-parser directly instead of Babel parser", () => {
    const manifest = readCoreManifest();

    expect(manifest.dependencies?.["yuku-parser"]).toBe("0.5.48");
    expect(manifest.dependencies?.["@babel/parser"]).toBeUndefined();
    expect(manifest.devDependencies?.["@yuku-toolchain/types"]).toBeUndefined();
  });
});
