import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// import.meta.resolve() runs at runtime (not inlined at bundle time), resolves
// through package exports, and is the Web-standard API. The main entry is
// `src/furin.ts` (or `dist/furin.js`), so we strip two path segments to reach
// the package root.
const _pkgRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@teyik0/furin"))));
const _pkgSrcDirRaw = existsSync(join(_pkgRoot, "src", "furin.ts"))
  ? join(_pkgRoot, "src")
  : join(_pkgRoot, "dist");
// Normalize to forward slashes so endsWith checks and template paths work on Windows.
const _pkgSrcDir = _pkgSrcDirRaw.replace(/\\/g, "/");
const _ext = _pkgSrcDir.endsWith("/src") ? ".ts" : ".js";
const INTERNAL_MODULE_PATH = `${_pkgSrcDir}/server/internal${_ext}`;
const RUNTIME_ENV_MODULE_PATH = `${_pkgSrcDir}/server/runtime-env${_ext}`;

export interface EntryTemplateOptions {
  buildId?: string;
  extraContext?: string[];
  extraImports?: string[];
  headerComment: string;
  rootConventions?: { errorPath?: string; notFoundPath?: string };
  rootPath: string;
  routeMetadata?: Record<
    string,
    {
      segmentBoundaries: Array<{
        depth: number;
        path: string;
        errorPath?: string;
        notFoundPath?: string;
      }>;
    }
  >;
  routes: Array<{ mode: "ssr" | "ssg" | "isr"; path: string; pattern: string }>;
  serverEntry: string;
  ssgCache?: Record<
    string,
    {
      cachedAt: number;
      html: string;
      ndjson: string;
      status: number;
    }
  >;
}

/** Unified options for generating a build entry (compile or disk-based). */
export interface BuildEntryOptions extends Omit<EntryTemplateOptions, "headerComment"> {
  outDir: string;
  headerComment?: string;
  /** Embed mode: bundles client assets into the binary via `with { type: "file" }`. */
  embed?: { clientDir: string };
  publicDir?: string;
}

function collectConventionPaths(
  rootConventions: EntryTemplateOptions["rootConventions"],
  routeMetadata: EntryTemplateOptions["routeMetadata"]
): string[] {
  const paths: string[] = [];
  if (rootConventions?.errorPath) {
    paths.push(rootConventions.errorPath);
  }
  if (rootConventions?.notFoundPath) {
    paths.push(rootConventions.notFoundPath);
  }
  if (routeMetadata) {
    for (const meta of Object.values(routeMetadata)) {
      for (const seg of meta.segmentBoundaries) {
        if (seg.errorPath) {
          paths.push(seg.errorPath);
        }
        if (seg.notFoundPath) {
          paths.push(seg.notFoundPath);
        }
      }
    }
  }
  return [...new Set(paths)];
}

export function buildEntrySource(options: EntryTemplateOptions): string {
  const {
    buildId,
    headerComment,
    rootPath,
    routes,
    serverEntry,
    rootConventions,
    routeMetadata,
    ssgCache,
  } = options;
  let { extraImports, extraContext } = options;
  if (extraImports === undefined) {
    extraImports = [];
  }
  if (extraContext === undefined) {
    extraContext = [];
  }

  const allModulePaths = [
    rootPath,
    ...routes.map((r) => r.path),
    ...collectConventionPaths(rootConventions, routeMetadata),
  ];
  const moduleImports: string[] = [];
  const moduleEntries: string[] = [];

  for (let i = 0; i < allModulePaths.length; i++) {
    const absPath = (allModulePaths[i] as string).replace(/\\/g, "/");
    const varName = `_mod${i}`;
    moduleImports.push(`import * as ${varName} from ${JSON.stringify(absPath)};`);
    moduleEntries.push(`  ${JSON.stringify(absPath)}: ${varName},`);
  }

  const routeEntries = routes.map(
    (r) =>
      `    { pattern: ${JSON.stringify(r.pattern)}, path: ${JSON.stringify(r.path.replace(/\\/g, "/"))}, mode: ${JSON.stringify(r.mode)} },`
  );

  const rootConventionsLine = rootConventions
    ? `  rootConventions: ${JSON.stringify(rootConventions)},`
    : "";
  const routeMetadataLine = routeMetadata
    ? `  routeMetadata: ${JSON.stringify(routeMetadata)},`
    : "";
  const ssgCacheLine = ssgCache ? `  ssgCache: ${JSON.stringify(ssgCache)},` : "";

  const lines = [
    headerComment,
    `import { __setCompileContext } from ${JSON.stringify(INTERNAL_MODULE_PATH)};`,
    `import { __setDevMode } from ${JSON.stringify(RUNTIME_ENV_MODULE_PATH)};`,
    ...moduleImports,
    ...(extraImports.length > 0 ? ["", ...extraImports] : []),
    "",
    "// Force production mode — Bun may inline process.env.NODE_ENV at bundle time.",
    "__setDevMode(false);",
    'process.env.NODE_ENV = "production";',
    "",
    "__setCompileContext({",
    `  buildId: ${JSON.stringify(buildId ?? "")},`,
    `  rootPath: ${JSON.stringify(rootPath.replace(/\\/g, "/"))},`,
    rootConventionsLine,
    "  modules: {",
    ...moduleEntries,
    "  },",
    "  routes: [",
    ...routeEntries,
    "  ],",
    routeMetadataLine,
    ssgCacheLine,
    ...extraContext,
    "});",
    "",
    `await import(${JSON.stringify(serverEntry.replace(/\\/g, "/"))});`,
    "",
  ];

  return lines.join("\n");
}
