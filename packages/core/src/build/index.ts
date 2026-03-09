import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildBunTarget } from "../adapter/bun";
import type { BuildTarget } from "../config";
import { scanPages } from "../router";
import { writeRouteTypes } from "./route-types";
import {
  assertBuildTarget,
  ensureDir,
  resolveBuildRoot,
  resolveServerEntry,
  toBuildRouteManifestEntry,
  toPosixPath,
  writeJsonFile,
} from "./shared";
import type {
  BuildAppOptions,
  BuildAppResult,
  BuildManifest,
  TypegenOptions,
} from "./types";

export type {
  BuildAppOptions,
  BuildAppResult,
  BuildClientOptions,
  BuildManifest,
  BuildRouteManifestEntry,
  TargetBuildManifest,
  TypegenOptions,
} from "./types";
export { buildClient } from "./client";
export { writeDevFiles } from "./hydrate";
export { patternToTypeString, schemaToTypeString, writeRouteTypes } from "./route-types";

const IMPLEMENTED_TARGETS = ["bun", "node"] as const satisfies BuildTarget[];

export async function generateTypes(options: TypegenOptions): Promise<string> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const pagesDir = resolve(rootDir, options.pagesDir ?? "src/pages");
  const buildRoot = resolveBuildRoot(rootDir, options.outDir);
  const typesDir = join(buildRoot, "shared");
  const { routes } = await scanPages(pagesDir);

  ensureDir(typesDir);
  writeRouteTypes(routes, typesDir);

  return join(typesDir, "routes.d.ts");
}

export function readTargetBuildManifest(
  rootDir: string,
  target: BuildTarget,
  outDir?: string
): import("./types").TargetBuildManifest | null {
  const buildRoot = resolveBuildRoot(rootDir, outDir);
  const path = join(buildRoot, target, "manifest.json");
  if (!existsSync(path)) {
    return null;
  }

  return JSON.parse(readFileSync(path, "utf8")) as import("./types").TargetBuildManifest;
}

export async function buildApp(options: BuildAppOptions): Promise<BuildAppResult> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const pagesDir = resolve(rootDir, options.pagesDir ?? "src/pages");
  const buildRoot = resolveBuildRoot(rootDir, options.outDir);
  const sharedDir = join(buildRoot, "shared");
  const serverEntry = resolveServerEntry(rootDir, options.serverEntry);
  const requestedTargets =
    options.target === "all"
      ? [...IMPLEMENTED_TARGETS]
      : [options.target].map((target) => {
          assertBuildTarget(target);
          return target;
        });

  const { root, routes } = await scanPages(pagesDir);
  if (!root) {
    throw new Error(
      "[elyra] No root layout found. Create a root.tsx in your pages directory with a layout component."
    );
  }

  ensureDir(buildRoot);
  ensureDir(sharedDir);
  writeRouteTypes(routes, sharedDir);

  const manifest: BuildManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    rootDir: toPosixPath(rootDir),
    pagesDir: toPosixPath(relative(rootDir, pagesDir)),
    rootPath: toPosixPath(relative(rootDir, root.path)),
    serverEntry: serverEntry ? toPosixPath(relative(rootDir, serverEntry)) : null,
    routes: routes.map((route) => toBuildRouteManifestEntry(route, rootDir)),
    targets: {},
  };

  for (const target of requestedTargets) {
    switch (target) {
      case "bun":
        manifest.targets.bun = await buildBunTarget(
          routes,
          rootDir,
          buildRoot,
          root.path,
          serverEntry,
          options
        );
        break;
      case "node":
      case "vercel":
      case "cloudflare":
        throw new Error(
          `[elyra] \`--target ${target}\` is planned but not implemented yet in this branch.`
        );
      default:
        throw new Error(`[elyra] Unsupported build target "${target}"`);
    }
  }

  writeJsonFile(join(buildRoot, "manifest.json"), manifest);

  return {
    manifest,
    targets: manifest.targets,
  };
}
