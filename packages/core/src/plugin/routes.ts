import { mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type AnyElysia, Elysia } from "elysia";
import { detectLoaderFromPath } from "../server/lang-detect.ts";

const ROUTES_NAMESPACE_PREFIX = "furin-routes";
const ROUTES_REGISTRY_SPECIFIER = "furin/routes?registry";
const ROUTES_REGISTRY_FILTER = /^furin\/routes\?registry$/;
const ROUTE_FILE_FILTER = /^furin-route-file:.+$/;
const ROUTE_FILE_QUERY_FILTER = /\?furin-route=[a-zA-Z0-9_]+$/;
const ROUTES_REGISTRY_FILE_FILTER = /[\\/]\.furin-routes-registry\.ts\?furin-virtual$/;
const CLIENT_ROUTES_NAMESPACE = "furin-routes-client";
const CLIENT_ROUTES_FILTER = /^(?:@teyik0\/furin|furin)\/routes$/;
const SERVER_ROUTES_FILTER = /^(?:@teyik0\/furin|furin)\/routes\?instance=.+$/;
const VIRTUAL_ROUTES_FILTER = /.*/;
const ROUTE_EXTENSION = /\.(?:jsx?|tsx?)$/;
const ROUTE_CONVENTIONS = new Set(["error", "not-found", "root"]);
const DEV_ROUTES_APPS_SYMBOL = Symbol.for("@teyik0/furin/dev-routes-apps");
const DEV_ROUTE_WATCHERS_SYMBOL = Symbol.for("@teyik0/furin/dev-route-watchers");
const DEV_ROUTES_FILE_FILTER = /[\\/]routes\.ts\?instance=[^&]+$/;

const devInstancesBySpecifier = new Map<string, RouteInstanceSpec>();
let devRoutesPluginRegistered = false;

export interface RouteInstanceSpec {
  pagesDir: string;
  prefix: string;
}

export interface CreateRoutesPluginOptions {
  instances: RouteInstanceSpec[];
  target: "client" | "server";
}

export interface DevRouteTopologyWatcher {
  close: () => void;
}

export interface DevRouteTopologyWatcherOptions {
  instance: RouteInstanceSpec;
  onTopologyChange: () => Promise<void> | void;
  pollIntervalMs: number;
}

interface DevRouteTopologyWatcherState extends DevRouteTopologyWatcherOptions {
  pending: boolean;
  refreshing: boolean;
  source: string;
  timer: ReturnType<typeof setInterval>;
}

function instanceKey(instance: RouteInstanceSpec): string {
  return `${resolve(instance.pagesDir)}\0${instance.prefix}`;
}

export function routeModuleSpecifier(instance: RouteInstanceSpec): string {
  return `@teyik0/furin/routes?instance=${Bun.hash(instanceKey(instance)).toString(16)}`;
}

function instanceNamespace(instance: RouteInstanceSpec): string {
  return `${ROUTES_NAMESPACE_PREFIX}-${Bun.hash(instanceKey(instance)).toString(16)}`;
}

interface RouteFile {
  id: string;
  path: string;
  sourcePath: string;
}

interface RouteTreeNode {
  children: RouteTreeNode[];
  fileRoutes: RouteFile[];
  indexRoute: RouteFile | undefined;
  layout: RouteFile | undefined;
  name: string;
}

interface ScannedRouteFile {
  base: string;
  directorySegments: string[];
  sourcePath: string;
}

function scanRouteFiles(
  directory: string,
  directorySegments: string[],
  files: ScannedRouteFile[]
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Underscore-prefixed directories are co-located private folders
      // (components, libs) — never route segments.
      if (entry.name.startsWith("_")) {
        continue;
      }
      scanRouteFiles(join(directory, entry.name), [...directorySegments, entry.name], files);
      continue;
    }
    const extension = extname(entry.name);
    if (!ROUTE_EXTENSION.test(extension) || entry.name.endsWith(".d.ts")) {
      continue;
    }
    const base = entry.name.slice(0, -extension.length);
    if (ROUTE_CONVENTIONS.has(base)) {
      continue;
    }
    // Underscore-prefixed files are private co-located modules — except the
    // `_route` layout convention, resolved downstream by buildRouteTree.
    if (base.startsWith("_") && base !== "_route") {
      continue;
    }
    files.push({
      base,
      directorySegments,
      sourcePath: join(directory, entry.name),
    });
  }
}

function segmentPath(segment: string): string {
  return segment.startsWith("[") && segment.endsWith("]") ? `:${segment.slice(1, -1)}` : segment;
}

function routePath(segments: string[]): string {
  return segments.length === 0 ? "/" : `/${segments.map(segmentPath).join("/")}`;
}

function routeId(instanceId: string, path: string): string {
  return `_route_${instanceId}_${path.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

function buildRouteTree(pagesDir: string, instanceId: string): RouteTreeNode {
  const scannedFiles: ScannedRouteFile[] = [];
  scanRouteFiles(pagesDir, [], scannedFiles);
  const nodes = new Map<string, RouteTreeNode>();

  const ensureNode = (segments: string[]): RouteTreeNode => {
    const key = segments.join("/");
    const existing = nodes.get(key);
    if (existing) {
      return existing;
    }
    const node: RouteTreeNode = {
      children: [],
      fileRoutes: [],
      indexRoute: undefined,
      layout: undefined,
      name: segments.at(-1) ?? "",
    };
    nodes.set(key, node);
    if (segments.length > 0) {
      ensureNode(segments.slice(0, -1)).children.push(node);
    }
    return node;
  };
  const root = ensureNode([]);

  for (const file of scannedFiles) {
    const node = ensureNode(file.directorySegments);
    if (file.base === "_route") {
      const path = `${routePath(file.directorySegments)}#layout`;
      node.layout = { id: routeId(instanceId, path), path: "", sourcePath: file.sourcePath };
      continue;
    }
    const path =
      file.base === "index"
        ? routePath(file.directorySegments)
        : routePath([...file.directorySegments, file.base]);
    const route = { id: routeId(instanceId, path), path, sourcePath: file.sourcePath };
    if (file.base === "index") {
      node.indexRoute = route;
    } else {
      node.fileRoutes.push(route);
    }
  }
  return root;
}

function collectRouteFiles(root: RouteTreeNode): RouteFile[] {
  const files: RouteFile[] = [];
  const nodes = [root];
  while (nodes.length > 0) {
    const node = nodes.pop();
    if (!node) {
      continue;
    }
    if (node.layout) {
      files.push(node.layout);
    }
    if (node.indexRoute) {
      files.push(node.indexRoute);
    }
    files.push(...node.fileRoutes);
    nodes.push(...node.children);
  }
  return files;
}

export function routeSourcePaths(instance: RouteInstanceSpec): string[] {
  const instanceId = Bun.hash(instanceKey(instance)).toString(16);
  return collectRouteFiles(buildRouteTree(instance.pagesDir, instanceId))
    .map(({ sourcePath }) => resolve(sourcePath))
    .toSorted((left, right) => left.localeCompare(right));
}

function routeTopologySource(instance: RouteInstanceSpec): string {
  const pagesDir = resolve(instance.pagesDir);
  const paths = routeSourcePaths(instance).map((path) =>
    relative(pagesDir, path).replaceAll("\\", "/")
  );
  return `${JSON.stringify(paths)}\n`;
}

function devRouteTopologyWatchers(): Map<string, DevRouteTopologyWatcherState> {
  const existing = Reflect.get(globalThis, DEV_ROUTE_WATCHERS_SYMBOL);
  if (existing instanceof Map) {
    return existing as Map<string, DevRouteTopologyWatcherState>;
  }
  const watchers = new Map<string, DevRouteTopologyWatcherState>();
  Reflect.set(globalThis, DEV_ROUTE_WATCHERS_SYMBOL, watchers);
  return watchers;
}

async function refreshRouteTopology(state: DevRouteTopologyWatcherState): Promise<void> {
  if (state.refreshing) {
    state.pending = true;
    return;
  }
  state.refreshing = true;
  try {
    state.pending = false;
    const source = routeTopologySource(state.instance);
    if (source !== state.source) {
      await state.onTopologyChange();
      state.source = source;
    }
  } catch (error) {
    console.error("[furin] Failed to refresh route topology", error);
  } finally {
    state.refreshing = false;
    if (state.pending) {
      await refreshRouteTopology(state);
    }
  }
}

export function registerDevRouteTopologyWatcher(
  options: DevRouteTopologyWatcherOptions
): DevRouteTopologyWatcher {
  const watcherKey = instanceKey(options.instance);
  const watchers = devRouteTopologyWatchers();
  const existing = watchers.get(watcherKey);
  if (existing) {
    existing.instance = options.instance;
    existing.onTopologyChange = options.onTopologyChange;
    return {
      close: () => {
        clearInterval(existing.timer);
        watchers.delete(watcherKey);
      },
    };
  }

  const source = routeTopologySource(options.instance);
  let state: DevRouteTopologyWatcherState;
  const timer = setInterval(() => {
    refreshRouteTopology(state).catch((error) => {
      console.error("[furin] Failed to poll route topology", error);
    });
  }, options.pollIntervalMs);
  timer.unref();
  state = {
    ...options,
    pending: false,
    refreshing: false,
    source,
    timer,
  };
  watchers.set(watcherKey, state);

  return {
    close: () => {
      clearInterval(timer);
      watchers.delete(watcherKey);
    },
  };
}

function emitRouteNode(node: RouteTreeNode, indentation: string): string {
  const childIndentation = `${indentation}  `;
  const prefix = node.name ? `/${segmentPath(node.name)}` : "";
  const head = `new Elysia({ prefix: ${JSON.stringify(prefix)} })`;
  const content: string[] = [];
  if (node.indexRoute) {
    content.push(
      `${childIndentation}.use(new Elysia({ prefix: "" }).use(${node.indexRoute.id}.elysia))`
    );
  }
  for (const route of node.fileRoutes) {
    const segment = route.path.slice(route.path.lastIndexOf("/") + 1);
    content.push(
      `${childIndentation}.use(new Elysia({ prefix: ${JSON.stringify(`/${segment}`)} }).use(${route.id}.elysia))`
    );
  }
  for (const child of node.children) {
    content.push(`${childIndentation}.use(`);
    content.push(emitRouteNode(child, `${childIndentation}  `));
    content.push(`${childIndentation})`);
  }
  if (node.layout) {
    return [
      `${head}.use(`,
      `${childIndentation}${node.layout.id}.elysia`,
      ...content.map((line) => `  ${line}`),
      `${childIndentation})`,
    ].join("\n");
  }
  return [head, ...content].join("\n");
}

interface GeneratedServerInstance {
  appExpression: string;
  exportName: string;
  imports: string;
}

interface RouteModuleInfo {
  routePath: string;
  sourcePath: string;
}

function routeFileSpecifier(route: RouteFile): string {
  return `furin-route-file:${route.id}`;
}

async function retainComposableRoutes(node: RouteTreeNode): Promise<void> {
  const isComposable = async (route: RouteFile): Promise<boolean> => {
    const module = await loadRouteModule(route.sourcePath);
    return typeof module.route?.elysia === "object" && module.route.elysia !== null;
  };

  if (node.layout && !(await isComposable(node.layout))) {
    node.layout = undefined;
  }
  if (node.indexRoute && !(await isComposable(node.indexRoute))) {
    node.indexRoute = undefined;
  }
  node.fileRoutes = (
    await Promise.all(
      node.fileRoutes.map(async (route) => ({ keep: await isComposable(route), route }))
    )
  )
    .filter(({ keep }) => keep)
    .map(({ route }) => route);
  await Promise.all(node.children.map((child) => retainComposableRoutes(child)));
}

async function generateServerInstance(
  instance: RouteInstanceSpec,
  routeFilesBySpecifier: Map<string, RouteModuleInfo>
): Promise<GeneratedServerInstance> {
  const instanceId = Bun.hash(instanceKey(instance)).toString(16);
  const tree = buildRouteTree(instance.pagesDir, instanceId);
  await retainComposableRoutes(tree);
  const imports = collectRouteFiles(tree)
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))
    .map((route) => {
      const specifier = routeFileSpecifier(route);
      routeFilesBySpecifier.set(specifier, {
        routePath: route.path,
        sourcePath: resolve(route.sourcePath),
      });
      return `import { route as ${route.id} } from ${JSON.stringify(specifier)};`;
    })
    .join("\n");
  return {
    appExpression: emitRouteNode(tree, ""),
    exportName: `furinApp_${instanceId}`,
    imports,
  };
}

async function serverRegistrySource(
  instances: RouteInstanceSpec[],
  routeFilesBySpecifier: Map<string, RouteModuleInfo>
): Promise<string> {
  routeFilesBySpecifier.clear();
  const generated = await Promise.all(
    instances.map((instance) => generateServerInstance(instance, routeFilesBySpecifier))
  );
  return `import { Elysia } from "elysia";
${generated.map(({ imports }) => imports).join("\n")}

${generated
  .map(({ appExpression, exportName }) => `export const ${exportName} = ${appExpression};`)
  .join("\n")}
`;
}

export function validateRouteParams(
  path: string,
  schemas: { params?: { properties?: object } } | undefined
): void {
  const pathParams = path
    .split("/")
    .filter((segment) => segment.startsWith(":"))
    .map((segment) => segment.slice(1));
  if (pathParams.length === 0) {
    return;
  }
  const schemaParams = schemas?.params?.properties ? Object.keys(schemas.params.properties) : [];
  const missing = pathParams.filter((param) => !schemaParams.includes(param));
  if (missing.length > 0) {
    throw new Error(
      `[furin] ${JSON.stringify(path)}: path params missing from the params schema: ${missing.join(", ")}`
    );
  }
}

const ROUTE_MODULE_CACHE_SYMBOL = Symbol.for("@teyik0/furin/route-module-cache");

interface CachedRouteModule {
  module: Record<string, unknown>;
  mtimeMs: number;
}

/**
 * TanStack-style incremental generator cache (routeNodeCache + mtime check):
 * a route module is re-evaluated only when its mtime changed. Unchanged
 * modules are served from the cache, so a full topology scan costs
 * O(changes) module evaluations instead of O(routes). Lives on globalThis so
 * the cache survives Bun soft reloads (the mtime key makes a stale entry
 * self-heal on the next scan after any file edit).
 */
function routeModuleCache(): Map<string, CachedRouteModule> {
  const existing = Reflect.get(globalThis, ROUTE_MODULE_CACHE_SYMBOL);
  if (existing instanceof Map) {
    return existing as Map<string, CachedRouteModule>;
  }
  const cache = new Map<string, CachedRouteModule>();
  Reflect.set(globalThis, ROUTE_MODULE_CACHE_SYMBOL, cache);
  return cache;
}

async function importRouteModule(sourcePath: string): Promise<Record<string, unknown>> {
  const cache = routeModuleCache();
  let mtimeMs = 0;
  try {
    ({ mtimeMs } = statSync(sourcePath));
  } catch {
    mtimeMs = 0; // deleted between scan and import — let the import surface it
  }
  const cached = cache.get(sourcePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.module;
  }
  const moduleUrl = `${pathToFileURL(sourcePath).href}?furin-routes=${mtimeMs}`;
  const module = (await import(moduleUrl)) as Record<string, unknown>;
  cache.set(sourcePath, { module, mtimeMs });
  return module;
}

async function validateRouteModules(routeFiles: Iterable<RouteModuleInfo>): Promise<void> {
  await Promise.all(
    [...routeFiles]
      .filter((routeFile) => routeFile.routePath !== "")
      .map(async (routeFile) => {
        const module = (await importRouteModule(routeFile.sourcePath)) as {
          route?: { schemas?: { params?: { properties?: object } } };
        };
        validateRouteParams(routeFile.routePath, module.route?.schemas);
      })
  );
}

interface ClientRouteMetadata {
  hasLoader: boolean;
  mode: string;
  pattern: string;
}

async function loadRouteModule(sourcePath: string): Promise<{
  route?: {
    elysia?: AnyElysia;
    loader?: unknown;
    mode?: string;
    schemas?: { params?: { properties?: object } };
    useLoaderData?: () => unknown;
  };
}> {
  return (await importRouteModule(sourcePath)) as {
    route?: {
      elysia?: AnyElysia;
      loader?: unknown;
      mode?: string;
      schemas?: { params?: { properties?: object } };
      useLoaderData?: () => unknown;
    };
  };
}

async function composableRouteApp(route: RouteFile): Promise<AnyElysia | undefined> {
  const module = await loadRouteModule(route.sourcePath);
  if (!module.route?.elysia) {
    return;
  }
  if (route.path !== "") {
    validateRouteParams(route.path, module.route.schemas);
  }
  return module.route.elysia;
}

async function composeRuntimeNode(node: RouteTreeNode): Promise<AnyElysia> {
  const prefix = node.name ? `/${segmentPath(node.name)}` : "";
  const [layoutApp, indexRouteApp, fileRouteApps, childApps] = await Promise.all([
    node.layout ? composableRouteApp(node.layout) : undefined,
    node.indexRoute ? composableRouteApp(node.indexRoute) : undefined,
    Promise.all(node.fileRoutes.map((route) => composableRouteApp(route))),
    Promise.all(node.children.map((child) => composeRuntimeNode(child))),
  ]);
  const scope = layoutApp ?? new Elysia();

  if (indexRouteApp) {
    scope.use(new Elysia({ prefix: "" }).use(indexRouteApp));
  }
  for (const [index, route] of node.fileRoutes.entries()) {
    const routeApp = fileRouteApps[index];
    if (routeApp) {
      const segment = route.path.slice(route.path.lastIndexOf("/") + 1);
      scope.use(new Elysia({ prefix: `/${segment}` }).use(routeApp));
    }
  }
  for (const childApp of childApps) {
    scope.use(childApp);
  }

  return new Elysia({ prefix }).use(scope);
}

function composeRuntimeInstance(instance: RouteInstanceSpec): Promise<AnyElysia> {
  const instanceId = Bun.hash(instanceKey(instance)).toString(16);
  return composeRuntimeNode(buildRouteTree(instance.pagesDir, instanceId));
}

function devRoutesApps(): Map<string, AnyElysia> {
  const existing = Reflect.get(globalThis, DEV_ROUTES_APPS_SYMBOL);
  if (existing instanceof Map) {
    return existing as Map<string, AnyElysia>;
  }
  const apps = new Map<string, AnyElysia>();
  Reflect.set(globalThis, DEV_ROUTES_APPS_SYMBOL, apps);
  return apps;
}

export function registerDevRoutesPlugin(instances: RouteInstanceSpec[]): void {
  for (const instance of instances) {
    devInstancesBySpecifier.set(routeModuleSpecifier(instance), instance);
  }
  if (devRoutesPluginRegistered) {
    return;
  }
  devRoutesPluginRegistered = true;

  Bun.plugin({
    name: "furin-routes-dev",
    setup(build) {
      build.onLoad({ filter: DEV_ROUTES_FILE_FILTER }, async ({ path }) => {
        const queryIndex = path.indexOf("?instance=");
        const specifier = `@teyik0/furin/routes${path.slice(queryIndex)}`;
        const instance = devInstancesBySpecifier.get(specifier);
        if (!instance) {
          throw new Error(`[furin] Unknown dev route instance: ${specifier}`);
        }
        devRoutesApps().set(specifier, await composeRuntimeInstance(instance));
        return {
          contents: `const registry = Reflect.get(globalThis, Symbol.for(${JSON.stringify(
            Symbol.keyFor(DEV_ROUTES_APPS_SYMBOL)
          )}));\nexport const furinApp = registry.get(${JSON.stringify(specifier)});\n`,
          loader: "js",
        };
      });
    },
  });
}

async function clientRoutesSource(instance: RouteInstanceSpec): Promise<string> {
  const tree = buildRouteTree(instance.pagesDir, Bun.hash(instanceKey(instance)).toString(16));
  const routes = collectRouteFiles(tree)
    .filter((route) => route.path !== "")
    .sort((left, right) => left.path.localeCompare(right.path));
  const metadata = await Promise.all(
    routes.map(async (routeFile): Promise<ClientRouteMetadata> => {
      const module = await loadRouteModule(routeFile.sourcePath);
      validateRouteParams(routeFile.path, module.route?.schemas);
      return {
        hasLoader: module.route?.loader !== undefined || module.route?.useLoaderData !== undefined,
        mode: module.route?.mode ?? "ssr",
        pattern: routeFile.path,
      };
    })
  );
  return `export const routes = ${JSON.stringify(metadata)};\n`;
}

function primaryInstance(instances: RouteInstanceSpec[]): RouteInstanceSpec {
  const instance = instances.find(({ prefix }) => prefix === "") ?? instances[0];
  if (!instance) {
    throw new Error("[furin] The routes plugin requires at least one instance");
  }
  return instance;
}

function routeTypeKey(path: string): string {
  if (!path.split("/").some((segment) => segment.startsWith(":"))) {
    return JSON.stringify(path);
  }
  const template = path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: emits a TypeScript template literal type
        return "${string}";
      }
      return segment.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
    })
    .join("/");
  return `[path: \`${template}\`]`;
}

function typeImportSpecifier(dtsPath: string, sourcePath: string): string {
  const extension = extname(sourcePath);
  const withoutExtension = sourcePath.slice(0, -extension.length);
  const path = relative(dirname(dtsPath), withoutExtension).replaceAll("\\", "/");
  return path.startsWith(".") ? path : `./${path}`;
}

async function routeTypesSource(instance: RouteInstanceSpec, dtsPath: string): Promise<string> {
  const tree = buildRouteTree(instance.pagesDir, Bun.hash(instanceKey(instance)).toString(16));
  const routes = collectRouteFiles(tree)
    .filter((route) => route.path !== "")
    .sort((left, right) => left.path.localeCompare(right.path));
  const entries = await Promise.all(
    routes.map(async (routeFile) => {
      const module = await loadRouteModule(routeFile.sourcePath);
      validateRouteParams(routeFile.path, module.route?.schemas);
      return `    ${routeTypeKey(routeFile.path)}: typeof import(${JSON.stringify(
        typeImportSpecifier(dtsPath, routeFile.sourcePath)
      )}).route;`;
    })
  );
  return `// AUTO-GENERATED by Furin. Do not edit manually.

declare module "@teyik0/furin/routes" {
  export interface RouteMap {
${entries.join("\n")}
  }
}
`;
}

async function atomicWrite(path: string, content: string): Promise<boolean> {
  const file = Bun.file(path);
  if ((await file.exists()) && (await file.text()) === content) {
    return false;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Bun.nanoseconds()}.tmp`;
  await Bun.write(temporaryPath, content);
  renameSync(temporaryPath, path);
  return true;
}

export async function materializeRouteTypes(options: {
  dtsPath: string;
  instance: RouteInstanceSpec;
}): Promise<boolean> {
  const content = await routeTypesSource(options.instance, options.dtsPath);
  return atomicWrite(options.dtsPath, content);
}

function serverProxySource(instance: RouteInstanceSpec): string {
  const exportName = `furinApp_${Bun.hash(instanceKey(instance)).toString(16)}`;
  return `export { ${exportName} as furinApp } from ${JSON.stringify(ROUTES_REGISTRY_SPECIFIER)};\n`;
}

export function createRoutesPlugin(options: CreateRoutesPluginOptions): Bun.BunPlugin {
  const routeFilesBySpecifier = new Map<string, RouteModuleInfo>();
  const routeFilesByResolvedPath = new Map<string, RouteModuleInfo>();
  const registryVirtualPath = join(
    resolve(primaryInstance(options.instances).pagesDir),
    ".furin-routes-registry.ts?furin-virtual"
  );
  const instancesBySpecifier = new Map(
    options.instances.map(
      (instance) =>
        [
          routeModuleSpecifier(instance),
          { instance, namespace: instanceNamespace(instance) },
        ] as const
    )
  );

  return {
    name: `furin-routes-${options.target}`,
    setup(build) {
      if (options.target === "client") {
        const instance = primaryInstance(options.instances);
        build.onResolve({ filter: CLIENT_ROUTES_FILTER }, () => ({
          namespace: CLIENT_ROUTES_NAMESPACE,
          path: "@teyik0/furin/routes",
        }));
        build.onLoad(
          { filter: VIRTUAL_ROUTES_FILTER, namespace: CLIENT_ROUTES_NAMESPACE },
          async () => ({ contents: await clientRoutesSource(instance), loader: "js" })
        );
        return;
      }
      build.onResolve({ filter: SERVER_ROUTES_FILTER }, ({ path }) => {
        const registered = instancesBySpecifier.get(path);
        if (!registered) {
          throw new Error(`[furin] Unknown route instance: ${path}`);
        }
        return { namespace: registered.namespace, path };
      });
      build.onResolve({ filter: ROUTES_REGISTRY_FILTER }, () => ({
        namespace: "file",
        path: registryVirtualPath,
      }));
      build.onLoad({ filter: ROUTES_REGISTRY_FILE_FILTER, namespace: "file" }, async () => {
        const contents = await serverRegistrySource(options.instances, routeFilesBySpecifier);
        await validateRouteModules(routeFilesBySpecifier.values());
        return { contents, loader: "ts" };
      });
      build.onResolve({ filter: ROUTE_FILE_FILTER }, ({ path }) => {
        const routeFile = routeFilesBySpecifier.get(path);
        if (!routeFile) {
          throw new Error(`[furin] Unknown route module: ${path}`);
        }
        const resolvedPath = `${routeFile.sourcePath}?furin-route=${path.slice(
          "furin-route-file:".length
        )}`;
        routeFilesByResolvedPath.set(resolvedPath, routeFile);
        return { namespace: "file", path: resolvedPath };
      });
      build.onLoad({ filter: ROUTE_FILE_QUERY_FILTER, namespace: "file" }, async ({ path }) => {
        const routeFile = routeFilesByResolvedPath.get(path);
        if (!routeFile) {
          throw new Error(`[furin] Unknown route module: ${path}`);
        }
        return {
          contents: await Bun.file(routeFile.sourcePath).text(),
          loader: detectLoaderFromPath(routeFile.sourcePath),
        };
      });
      for (const { instance, namespace } of instancesBySpecifier.values()) {
        build.onLoad({ filter: VIRTUAL_ROUTES_FILTER, namespace }, () => ({
          contents: serverProxySource(instance),
          loader: "ts",
        }));
      }
    },
  };
}
