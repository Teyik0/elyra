import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { BuildTarget } from "../config";
import type { ResolvedRoute } from "../router";
import type { BuildRouteManifestEntry, TargetBuildManifest } from "./types";

export const DEFAULT_BUILD_ROOT = ".elyra/build";

export const CLIENT_MODULE_PATH = resolve(import.meta.dir, "../client.ts").replace(/\\/g, "/");
export const LINK_MODULE_PATH = resolve(import.meta.dir, "../link.tsx").replace(/\\/g, "/");

export function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

export function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function resolveBuildRoot(rootDir: string, outDir?: string): string {
  return resolve(rootDir, outDir ?? DEFAULT_BUILD_ROOT);
}

export function toBuildRouteManifestEntry(
  route: ResolvedRoute,
  rootDir: string
): BuildRouteManifestEntry {
  return {
    pattern: route.pattern,
    mode: route.mode,
    pagePath: toPosixPath(relative(rootDir, route.path)),
    hasLayout: route.routeChain.some((entry) => !!entry.layout),
    hasStaticParams: !!route.page?.staticParams,
    revalidate: route.page?._route.revalidate ?? null,
  };
}

export function buildTargetManifest(
  rootDir: string,
  buildRoot: string,
  target: BuildTarget,
  serverEntry: string | null
): TargetBuildManifest {
  const targetDir = join(buildRoot, target);
  const manifestPath = join(targetDir, "manifest.json");
  return {
    target,
    generatedAt: new Date().toISOString(),
    targetDir: toPosixPath(relative(rootDir, targetDir)),
    clientDir: toPosixPath(relative(rootDir, join(targetDir, "client"))),
    templatePath: toPosixPath(relative(rootDir, join(targetDir, "client", "index.html"))),
    routeTypesPath: toPosixPath(relative(rootDir, join(targetDir, "routes.d.ts"))),
    manifestPath: toPosixPath(relative(rootDir, manifestPath)),
    serverPath: null,
    serverEntry: serverEntry ? toPosixPath(relative(rootDir, serverEntry)) : null,
  };
}

