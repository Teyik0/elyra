import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildTarget } from "../config";
import { resolveBuildRoot } from "./shared";
import type { TargetBuildManifest } from "./types";

/**
 * Reads the pre-built target manifest from disk.
 * Intentionally kept in a standalone module with no heavy dependencies
 * (no oxc-parser, no MagicString) so it can be safely imported in compiled
 * server binaries where native addons are unavailable.
 */
export function readTargetBuildManifest(
  rootDir: string,
  target: BuildTarget,
  outDir?: string
): TargetBuildManifest | null {
  const buildRoot = resolveBuildRoot(rootDir, outDir);
  const path = join(buildRoot, target, "manifest.json");
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8")) as TargetBuildManifest;
}
