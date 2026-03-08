import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { transformForClient } from "./adapter/transform-client";
import { BUILD_TARGETS, type BuildTarget } from "./config";
import { type ResolvedRoute, scanPages } from "./router";
import { generateIndexHtml } from "./template-shell";

export interface BuildClientOptions {
  dev?: boolean;
  outDir?: string;
  pagesDir?: string;
  rootPath: string;
}

export interface BuildRouteManifestEntry {
  hasLayout: boolean;
  hasStaticParams: boolean;
  mode: ResolvedRoute["mode"];
  pagePath: string;
  pattern: string;
  revalidate: number | null;
}

export interface TargetBuildManifest {
  clientDir: string;
  generatedAt: string;
  manifestPath: string;
  routeTypesPath: string;
  serverEntry: string | null;
  serverPath: string | null;
  target: BuildTarget;
  targetDir: string;
  templatePath: string;
}

export interface BuildManifest {
  generatedAt: string;
  pagesDir: string;
  rootDir: string;
  rootPath: string;
  routes: BuildRouteManifestEntry[];
  serverEntry: string | null;
  targets: Partial<Record<BuildTarget, TargetBuildManifest>>;
  version: 1;
}

export interface BuildAppOptions {
  compile?: boolean;
  minify?: boolean;
  outDir?: string;
  pagesDir?: string;
  rootDir?: string;
  serverEntry?: string;
  sourcemap?: boolean;
  target: BuildTarget | "all";
}

export interface BuildAppResult {
  manifest: BuildManifest;
  targets: Partial<Record<BuildTarget, TargetBuildManifest>>;
}

export interface TypegenOptions {
  outDir?: string;
  pagesDir?: string;
  rootDir?: string;
}

const TS_FILE_FILTER = /\.(tsx|ts)$/;
const REACT_IMPORT_RE = /import\s+React\b/;
const CLIENT_MODULE_PATH = resolve(import.meta.dir, "client.ts").replace(/\\/g, "/");
const LINK_MODULE_PATH = resolve(import.meta.dir, "link.tsx").replace(/\\/g, "/");
type BunBuildAliasConfig = Bun.BuildConfig & {
  alias?: Record<string, string>;
  outfile?: string;
  packages?: "bundle" | "external";
  write?: boolean;
};

const DEFAULT_BUILD_ROOT = ".elyra/build";

// ── Hydrate entry ──────────────────────────────────────────────────────────

/**
 * Generates the client hydration entry.
 *
 * Renders into <div id="root"> (the SSR outlet element) and retains the React
 * root across hot reloads via import.meta.hot.data.root so React Fast Refresh
 * applies in-place instead of remounting.
 *
 * @param clientPaths - Optional map from source abs path → pre-transformed abs path.
 *   When provided, imports reference the browser-safe pre-transformed files in
 *   .elyra/pages/ instead of the TypeScript source files.
 */
function generateHydrateEntry(routes: ResolvedRoute[], rootPath: string): string {
  const routeEntries: string[] = [];

  for (const route of routes) {
    const resolvedRoute = route as ResolvedRoute;
    const resolvedPage = resolvedRoute.path.replace(/\\/g, "/");

    const regexPattern = resolvedRoute.pattern.replace(/:[^/]+/g, "([^/]+)").replace(/\*/g, "(.*)");

    routeEntries.push(
      ` { pattern: "${resolvedRoute.pattern}", regex: new RegExp("^${regexPattern}$"), load: () => import("${resolvedPage}") }`
    );
  }

  return `import { hydrateRoot, createRoot } from "react-dom/client";
import { createElement } from "react";
import { RouterProvider } from "${resolve(import.meta.dir, "link.tsx").replace(/\\/g, "/")}";
import { route as root } from "${rootPath.replace(/\\/g, "/")}";

const routes = [
${routeEntries.join(",\n")}
];

const pathname = window.location.pathname;
const _match = routes.find((r) => r.regex.test(pathname));

// Eagerly load only the current page module for initial hydration.
// All other pages are loaded on demand when the user navigates to them.
if (_match) {
  const _mod = await _match.load();
  const match = { ..._match, component: _mod.default.component, pageRoute: _mod.default._route };

  const dataEl = document.getElementById("__ELYSION_DATA__");
  const loaderData = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};
  const rootEl = document.getElementById("root") as HTMLElement;

  const app = createElement(RouterProvider, {
    routes,
    root,
    initialMatch: match,
    initialData: loaderData,
  } as any);

  if (import.meta.hot) {
    // Retain React root across hot reloads so Fast Refresh applies in-place.
    const hotRoot = (import.meta.hot.data.root ??= rootEl.innerHTML.trim()
      ? hydrateRoot(rootEl, app)
      : createRoot(rootEl));
    hotRoot.render(app);
  } else if (rootEl.innerHTML.trim()) {
    hydrateRoot(rootEl, app);
  } else {
    createRoot(rootEl).render(app);
  }
} else {
  console.warn("[elyra] No matching route for", pathname);
}
`;
}

function rewriteFrameworkImports(source: string): string {
  return source
    .replaceAll(`"elyra/client"`, JSON.stringify(CLIENT_MODULE_PATH))
    .replaceAll(`'elyra/client'`, JSON.stringify(CLIENT_MODULE_PATH))
    .replaceAll(`"elyra/link"`, JSON.stringify(LINK_MODULE_PATH))
    .replaceAll(`'elyra/link'`, JSON.stringify(LINK_MODULE_PATH));
}

/** @internal Exported for unit testing only. */
export function patternToTypeString(pattern: string): string {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional — generates TS template literal syntax
  const t = pattern.replace(/:[^/]+/g, "${string}").replace(/\*/g, "${string}");
  return t.includes("${") ? `\`${t}\`` : `"${t}"`;
}

/**
 * Converts a runtime TypeBox/JSON Schema object to a TypeScript type string.
 * Handles the common cases found in Elysia query schemas (string, number, boolean,
 * optional fields, nullable via anyOf).
 *
 * @internal Exported for unit testing only.
 */
export function schemaToTypeString(schema: unknown): string {
  if (!schema || typeof schema !== "object") {
    return "unknown";
  }
  const s = schema as Record<string, unknown>;
  if (s.anyOf && Array.isArray(s.anyOf)) {
    const parts = (s.anyOf as unknown[]).map(schemaToTypeString).filter((t) => t !== "null");
    return parts.join(" | ") || "unknown";
  }
  switch (s.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "object": {
      if (!s.properties || typeof s.properties !== "object") {
        return "Record<string, unknown>";
      }
      const required = new Set<string>(Array.isArray(s.required) ? (s.required as string[]) : []);
      const props = Object.entries(s.properties as Record<string, unknown>)
        .map(([k, v]) => `${k}${required.has(k) ? "" : "?"}: ${schemaToTypeString(v)}`)
        .join("; ");
      return `{ ${props} }`;
    }
    default:
      return "unknown";
  }
}

/**
 * Generates .elyra/routes.d.ts — augments RouteManifest in elyra/link
 * so that <Link to="..."> has type-safe autocompletion and <Link search={...}>
 * is typed per-route from the route's query schema.
 *
 * Users must add ".elyra/routes.d.ts" to their tsconfig.json "include" array once.
 */
/** @internal Exported for unit testing only. */
export function writeRouteTypes(routes: ResolvedRoute[], outDir: string): void {
  const entries = routes.map((r) => {
    const typeKey = patternToTypeString(r.pattern);
    const isDynamic = typeKey.startsWith("`");
    const querySchema = r.routeChain?.find((rt) => rt.query)?.query;
    const searchType = querySchema ? schemaToTypeString(querySchema) : "never";
    return isDynamic
      ? `    [key: ${typeKey}]: { search?: ${searchType} }`
      : `    ${typeKey}: { search?: ${searchType} }`;
  });

  const content = `// Auto-generated by Elyra. Do not edit manually.
// Add ".elyra/routes.d.ts" to your tsconfig.json "include" array to enable typed navigation.
import "elyra/link";

declare module "elyra/link" {
  interface RouteManifest {
${entries.join(";\n")};
  }
}
`;

  const typesPath = join(outDir, "routes.d.ts");
  const existing = existsSync(typesPath) ? readFileSync(typesPath, "utf8") : "";
  if (content !== existing) {
    writeFileSync(typesPath, content);
  }
}

// ── Dev: write files for Bun's native HTML bundler ────────────────────────

/**
 * The fixed HTML shell used both in dev (for Bun's HTML bundler) and as the
 * base for the production build entrypoint.  This content never changes —
 * commit it to the repository so the static import in server.ts always works.
 *
 * Bun's HTML bundler:
 *  - Replaces `<script src="./_hydrate.tsx">` with content-hashed chunk tags.
 *  - Injects the HMR WebSocket client into <head>.
 *  - Preserves <!--ssr-head--> and <!--ssr-outlet--> comments for SSR injection.
 */
/**
 * Writes _hydrate.tsx + index.html to outDir for dev (Bun HMR) mode.
 *
 * When pagesDir is provided, also pre-transforms all pages-dir files into
 * .elyra/pages/ (browser-safe JS) so that _hydrate.tsx imports server-free
 * modules — preventing "Browser build cannot import Bun builtin" errors that
 * occur when bundlers encounter bun:sqlite or elysia imports from page files.
 *
 * Only rewrites a file when its content has actually changed so Bun's --hot
 * watcher does not trigger a spurious reload on every server restart.
 */
export function writeDevFiles(routes: ResolvedRoute[], options: BuildClientOptions): void {
  const { outDir = "./.elyra", rootPath } = options;

  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const hydrateCode = generateHydrateEntry(routes, rootPath);
  const hydratePath = join(outDir, "_hydrate.tsx");
  const existingHydrate = existsSync(hydratePath) ? readFileSync(hydratePath, "utf8") : "";
  if (hydrateCode !== existingHydrate) {
    writeFileSync(hydratePath, hydrateCode);
  }

  const indexHtml = generateIndexHtml();
  const indexPath = join(outDir, "index.html");
  const existingIndex = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  if (indexHtml !== existingIndex) {
    writeFileSync(indexPath, indexHtml);
  }

  writeRouteTypes(routes, outDir);

  console.log(
    "[elyra] Dev files written (.elyra/_hydrate.tsx + .elyra/index.html + .elyra/routes.d.ts)"
  );
}

// ── Prod: full Bun.build() via HTML entrypoint ────────────────────────────

/**
 * Builds the production client bundle via Bun.build() using the generated
 * index.html as the HTML entrypoint.  Bun produces:
 *   .elyra/client/index.html  — processed template with hashed chunk paths
 *   .elyra/client/chunk-*.js  — code-split bundles
 *   .elyra/client/styles.css  — CSS (if imported)
 *
 * The output index.html is NOT served to browsers directly.  The server reads
 * it as an SSR template, injects the pre-rendered React HTML into
 * <!--ssr-outlet-->, and sends the complete page.
 */
export async function buildClient(
  routes: ResolvedRoute[],
  options: BuildClientOptions
): Promise<void> {
  const { outDir = "./.elyra", rootPath } = options;
  const clientDir = join(outDir, "client");

  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  if (!existsSync(clientDir)) {
    mkdirSync(clientDir, { recursive: true });
  }

  const hydrateCode = generateHydrateEntry(routes, rootPath);
  const hydratePath = join(outDir, "_hydrate.tsx");
  writeFileSync(hydratePath, hydrateCode);

  const indexHtml = generateIndexHtml();
  const indexPath = join(outDir, "index.html");
  writeFileSync(indexPath, indexHtml);

  writeRouteTypes(routes, outDir);

  console.log("[elyra] Building production client bundle…");

  const transformPlugin: Bun.BunPlugin = {
    name: "elyra-transform-client",
    setup(build) {
      build.onLoad({ filter: TS_FILE_FILTER }, async (args) => {
        const { path } = args;
        if (path.includes("node_modules")) {
          return undefined;
        }

        const code = await Bun.file(path).text();
        try {
          const result = transformForClient(code, path);
          let transformed = result.code;

          if (transformed.includes("React.createElement") && !REACT_IMPORT_RE.test(transformed)) {
            transformed = `import React from "react";\n${transformed}`;
          }

          transformed = rewriteFrameworkImports(transformed);

          return {
            contents: transformed,
            loader: path.endsWith(".tsx") ? "tsx" : "ts",
          };
        } catch (error) {
          console.error(`[elyra] Transform error for ${path}:`, error);
          return undefined;
        }
      });
    },
  };

  const clientBuildConfig: BunBuildAliasConfig = {
    entrypoints: [indexPath],
    outdir: clientDir,
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    plugins: [transformPlugin],
    alias: {
      "elyra/client": CLIENT_MODULE_PATH,
      "elyra/link": LINK_MODULE_PATH,
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  };

  const result = await Bun.build(clientBuildConfig);

  if (!result.success) {
    console.error("[elyra] Client build failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("Client build failed");
  }

  for (const output of result.outputs) {
    console.log(`[elyra]   ${output.path} (${(output.size / 1024).toFixed(1)} KB)`);
  }

  console.log("[elyra] Production client build complete");
}

function assertBuildTarget(target: string): asserts target is BuildTarget {
  if ((BUILD_TARGETS as readonly string[]).includes(target)) {
    return;
  }

  throw new Error(`[elyra] Unsupported build target "${target}"`);
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function resolveBuildRoot(rootDir: string, outDir?: string): string {
  return resolve(rootDir, outDir ?? DEFAULT_BUILD_ROOT);
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function toImportSpecifier(fromDir: string, targetPath: string): string {
  const relativePath = toPosixPath(relative(fromDir, targetPath));
  if (relativePath.startsWith(".")) {
    return relativePath;
  }
  return `./${relativePath}`;
}

function toBuildRouteManifestEntry(route: ResolvedRoute, rootDir: string): BuildRouteManifestEntry {
  return {
    pattern: route.pattern,
    mode: route.mode,
    pagePath: toPosixPath(relative(rootDir, route.pagePath)),
    hasLayout: route.routeChain.some((entry) => !!entry.layout),
    hasStaticParams: !!route.page?.staticParams,
    revalidate: route.page?._route.revalidate ?? null,
  };
}

function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function resolveServerEntry(rootDir: string, preferred?: string): string | null {
  const candidates = [preferred, "src/server.bun.ts", "src/server.ts", "src/app.ts"].filter(
    (value): value is string => !!value
  );

  for (const candidate of candidates) {
    const resolvedCandidate = resolve(rootDir, candidate);
    if (existsSync(resolvedCandidate)) {
      return resolvedCandidate;
    }
  }

  return null;
}

function buildTargetManifest(
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

async function buildBunTarget(
  routes: ResolvedRoute[],
  rootDir: string,
  buildRoot: string,
  rootPath: string,
  serverEntry: string | null,
  options: BuildAppOptions
): Promise<TargetBuildManifest> {
  if (options.compile) {
    throw new Error(
      "[elyra] `--compile` for `--target bun` is not wired yet. Use the default split output for now."
    );
  }

  const target = "bun" satisfies BuildTarget;
  const targetManifest = buildTargetManifest(rootDir, buildRoot, target, serverEntry);
  const targetDir = resolve(rootDir, targetManifest.targetDir);

  rmSync(targetDir, { force: true, recursive: true });
  ensureDir(targetDir);

  await buildClient(routes, {
    outDir: targetDir,
    rootPath,
  });

  writeJsonFile(resolve(rootDir, targetManifest.manifestPath), targetManifest);
  return targetManifest;
}

function generateNodeRuntimeModule(
  routes: ResolvedRoute[],
  rootPath: string,
  targetDir: string
): string {
  const routerModulePath = resolve(import.meta.dir, "router.ts");
  const utilsModulePath = resolve(import.meta.dir, "utils.ts");
  const rootImportPath = toImportSpecifier(targetDir, rootPath);
  const routerImportPath = toImportSpecifier(targetDir, routerModulePath);
  const utilsImportPath = toImportSpecifier(targetDir, utilsModulePath);

  const pageImports = routes
    .map(
      (route, index) =>
        `import page${index} from "${toImportSpecifier(targetDir, route.pagePath)}";`
    )
    .join("\n");

  const routeEntries = routes
    .map((route, index) => {
      const pageVar = `page${index}`;
      return [
        "(() => {",
        `  const page = ${pageVar};`,
        "  const routeChain = collectRouteChain(page);",
        "  return {",
        `    pattern: ${JSON.stringify(route.pattern)},`,
        "    page,",
        `    pagePath: ${JSON.stringify(route.pagePath)},`,
        `    path: ${JSON.stringify(route.path)},`,
        "    routeChain,",
        "    mode: resolveMode(page, routeChain),",
        "  };",
        "})()",
      ].join("\n");
    })
    .join(",\n");

  return [
    `import * as rootModule from "${rootImportPath}";`,
    pageImports,
    `import { resolveMode } from "${routerImportPath}";`,
    `import { collectRouteChain } from "${utilsImportPath}";`,
    "",
    `const rootRoute = "route" in rootModule ? rootModule.route : rootModule["default"];`,
    "",
    "export const root = {",
    `  path: ${JSON.stringify(rootPath)},`,
    "  route: rootRoute,",
    "};",
    "",
    "export const routes = [",
    routeEntries,
    "];",
    "",
  ].join("\n");
}

function generateNodeServerEntry(targetDir: string): string {
  const routerModulePath = resolve(import.meta.dir, "router.ts");
  const templateModulePath = resolve(import.meta.dir, "render/template.ts");
  const routerImportPath = toImportSpecifier(targetDir, routerModulePath);
  const templateImportPath = toImportSpecifier(targetDir, templateModulePath);

  return [
    `import { createServer } from "node:http";`,
    `import { fileURLToPath } from "node:url";`,
    `import { Readable } from "node:stream";`,
    `import { Elysia } from "elysia";`,
    `import { staticPlugin } from "@elysiajs/static";`,
    `import { createRoutePlugin } from "${routerImportPath}";`,
    `import { setProductionTemplatePath } from "${templateImportPath}";`,
    `import { root, routes } from "./runtime";`,
    "",
    `const clientDir = fileURLToPath(new URL("./client", import.meta.url));`,
    `const templatePath = fileURLToPath(new URL("./client/index.html", import.meta.url));`,
    "setProductionTemplatePath(templatePath);",
    "",
    "let app = new Elysia()",
    `  .use(await staticPlugin({ assets: clientDir, prefix: "/_client" }))`,
    "  .use(await staticPlugin());",
    "",
    "for (const route of routes) {",
    "  app = app.use(createRoutePlugin(route, root));",
    "}",
    "",
    "function toRequest(req, port) {",
    '  const origin = "http://" + (req.headers.host ?? "127.0.0.1:" + port);',
    `  const url = new URL(req.url ?? "/", origin);`,
    "  const headers = new Headers();",
    "  for (const [key, value] of Object.entries(req.headers)) {",
    "    if (Array.isArray(value)) {",
    "      for (const item of value) headers.append(key, item);",
    "    } else if (value !== undefined) {",
    "      headers.set(key, value);",
    "    }",
    "  }",
    `  const method = req.method ?? "GET";`,
    "  return new Request(url, {",
    "    method,",
    "    headers,",
    `    body: method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(req),`,
    `    duplex: "half",`,
    "  });",
    "}",
    "",
    "const port = Number(process.env.PORT ?? 3000);",
    "const server = createServer(async (req, res) => {",
    "  const response = await app.fetch(toRequest(req, port));",
    "  res.statusCode = response.status;",
    "  response.headers.forEach((value, key) => {",
    "    res.setHeader(key, value);",
    "  });",
    "  if (!response.body) {",
    "    res.end();",
    "    return;",
    "  }",
    "  const body = Buffer.from(await response.arrayBuffer());",
    "  res.end(body);",
    "});",
    "",
    "server.listen(port, () => {",
    '  console.log("[elyra:node] listening on " + port);',
    "});",
    "",
  ].join("\n");
}

async function buildNodeTarget(
  routes: ResolvedRoute[],
  rootDir: string,
  buildRoot: string,
  rootPath: string,
  serverEntry: string | null,
  options: BuildAppOptions
): Promise<TargetBuildManifest> {
  const target = "node" satisfies BuildTarget;
  const targetManifest = buildTargetManifest(rootDir, buildRoot, target, serverEntry);
  const targetDir = resolve(rootDir, targetManifest.targetDir);
  const runtimeEntryPath = join(targetDir, "runtime.ts");
  const serverEntryPath = join(targetDir, "server.entry.ts");
  const outputServerPath = join(targetDir, "server.js");

  rmSync(targetDir, { force: true, recursive: true });
  ensureDir(targetDir);

  await buildClient(routes, {
    outDir: targetDir,
    rootPath,
  });

  writeFileSync(runtimeEntryPath, generateNodeRuntimeModule(routes, rootPath, targetDir));
  writeFileSync(serverEntryPath, generateNodeServerEntry(targetDir));

  const nodeRuntimePlugin: Bun.BunPlugin = {
    name: "elyra-rewrite-framework-imports",
    setup(build) {
      build.onLoad({ filter: TS_FILE_FILTER }, async (args) => {
        const { path } = args;
        if (path.includes("node_modules")) {
          return undefined;
        }

        const code = await Bun.file(path).text();
        return {
          contents: rewriteFrameworkImports(code),
          loader: path.endsWith(".tsx") ? "tsx" : "ts",
        };
      });
    },
  };

  const serverBuildConfig: BunBuildAliasConfig = {
    entrypoints: [serverEntryPath],
    outfile: outputServerPath,
    write: false,
    target: "node",
    format: "esm",
    packages: "external",
    minify: options.minify ?? true,
    sourcemap: (options.sourcemap ?? false) ? "external" : "none",
    plugins: [nodeRuntimePlugin],
    alias: {
      "elyra/client": CLIENT_MODULE_PATH,
      "elyra/link": LINK_MODULE_PATH,
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  };

  const serverBuild = await Bun.build(serverBuildConfig);

  if (!serverBuild.success) {
    const errorOutput = serverBuild.logs.map((log) => log.message).join("\n");
    throw new Error(`[elyra] Node server build failed\n${errorOutput}`.trim());
  }

  const serverOutput = serverBuild.outputs.find((output) =>
    output.type.startsWith("text/javascript")
  );
  if (!serverOutput) {
    throw new Error("[elyra] Node server build did not emit a JavaScript bundle");
  }

  writeFileSync(outputServerPath, await serverOutput.text());

  const sourceMapOutput = serverBuild.outputs.find((output) => output.type.includes("json"));
  if (sourceMapOutput && (options.sourcemap ?? false)) {
    writeFileSync(`${outputServerPath}.map`, await sourceMapOutput.text());
  }

  targetManifest.serverPath = toPosixPath(relative(rootDir, outputServerPath));
  writeJsonFile(resolve(rootDir, targetManifest.manifestPath), targetManifest);
  return targetManifest;
}

export async function generateTypes(options: TypegenOptions = {}): Promise<string> {
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
): TargetBuildManifest | null {
  const buildRoot = resolveBuildRoot(rootDir, outDir);
  const path = join(buildRoot, target, "manifest.json");
  if (!existsSync(path)) {
    return null;
  }

  return JSON.parse(readFileSync(path, "utf8")) as TargetBuildManifest;
}

export async function buildApp(options: BuildAppOptions): Promise<BuildAppResult> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const pagesDir = resolve(rootDir, options.pagesDir ?? "src/pages");
  const buildRoot = resolveBuildRoot(rootDir, options.outDir);
  const sharedDir = join(buildRoot, "shared");
  const serverEntry = resolveServerEntry(rootDir, options.serverEntry);
  const requestedTargets =
    options.target === "all"
      ? [...BUILD_TARGETS]
      : [options.target].map((target) => {
          assertBuildTarget(target);
          return target;
        });

  const { root, routes } = await scanPages(pagesDir);
  if (!root) {
    throw new Error(
      "[elyra] No root.tsx found. Create a root.tsx in your pages directory with a layout component."
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
        manifest.targets.node = await buildNodeTarget(
          routes,
          rootDir,
          buildRoot,
          root.path,
          serverEntry,
          options
        );
        break;
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
