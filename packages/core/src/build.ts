import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ResolvedRoute } from "./router";
import { type BuildOutput, generateClientManifest } from "./rsc/manifest";
import type { ClientManifest, ModuleAnalysis } from "./rsc/types";
import { transformForClient } from "./transform-client";

export interface BuildClientOptions {
  dev?: boolean;
  outDir?: string;
  rootPath?: string | null;
}

export interface BuildClientResult {
  manifest: ClientManifest;
}

const TS_FILE_FILTER = /\.(tsx|ts)$/;

export async function buildClient(
  routes: ResolvedRoute[],
  options: BuildClientOptions = {}
): Promise<void> {
  // Delegate to buildClientWithRSC with empty analyses for backward compatibility
  await buildClientWithRSC(routes, new Map(), options);
}

export async function buildClientWithRSC(
  routes: ResolvedRoute[],
  analyses: Map<string, ModuleAnalysis>,
  options: BuildClientOptions = {}
): Promise<BuildClientResult> {
  const { outDir = "./.elysion", dev = false, rootPath = null } = options;
  const buildDir = outDir;
  const clientDir = join(outDir, "client");

  if (!existsSync(buildDir)) {
    mkdirSync(buildDir, { recursive: true });
  }
  if (!existsSync(clientDir)) {
    mkdirSync(clientDir, { recursive: true });
  }

  // Filter client routes based on analysis
  const clientRoutes = routes.filter((route) => {
    const analysis = analyses.get(route.pagePath);
    return analysis?.type === "client";
  });

  // Generate hydrate entry for client components
  const hydrateCode = dev
    ? generateDevHydrateEntry(clientRoutes.length > 0 ? clientRoutes : routes, rootPath)
    : generateHydrateEntry(clientRoutes.length > 0 ? clientRoutes : routes, rootPath);
  const hydratePath = join(buildDir, "_hydrate.tsx");
  writeFileSync(hydratePath, hydrateCode);

  console.log(`[elysion] Building client bundle with RSC (${dev ? "dev" : "production"})...`);
  console.log(`[elysion] Client routes: ${clientRoutes.length}/${routes.length}`);

  const transformPlugin: Bun.BunPlugin = {
    name: "elysion-transform-client",
    setup(build) {
      build.onLoad({ filter: TS_FILE_FILTER }, async (args) => {
        const path = args.path;
        if (path.includes("node_modules")) {
          return undefined;
        }

        const file = Bun.file(path);
        const code = await file.text();

        try {
          const result = transformForClient(code, path);
          return {
            contents: result.code,
            loader: path.endsWith(".tsx") ? "tsx" : "ts",
          };
        } catch (error) {
          console.error(`[elysion] Transform error for ${path}:`, error);
          return undefined;
        }
      });
    },
  };

  const result = await Bun.build({
    entrypoints: [hydratePath],
    outdir: clientDir,
    target: "browser",
    format: "esm",
    splitting: !dev,
    minify: !dev,
    naming: "[name].[ext]",
    plugins: dev ? [] : [transformPlugin],
    define: {
      "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production"),
    },
  });

  if (!result.success) {
    const errorMessages = result.logs.map(String).join("\n");
    throw new Error(
      `[elysion] Client build failed for ${routes.length} routes (${clientRoutes.length} client):\n${errorMessages}`
    );
  }

  for (const output of result.outputs) {
    console.log(`[elysion]   ${output.path} (${(output.size / 1024).toFixed(1)}KB)`);
  }

  // Generate client manifest
  const outputs: BuildOutput[] = result.outputs.map((o) => ({
    path: o.path,
    moduleIds: [], // Would need source map analysis for exact mapping
  }));

  const manifest = generateClientManifest([...analyses.values()], outputs);

  // Write manifest to disk
  const manifestPath = join(buildDir, "client-manifest.json");
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));
  console.log("[elysion] Client manifest generated");

  console.log("[elysion] Client build complete");

  return { manifest };
}

function generateHydrateEntry(routes: ResolvedRoute[], rootPath: string | null): string {
  const imports: string[] = [];
  const routeEntries: string[] = [];

  const hasRoot = rootPath !== null;
  if (hasRoot) {
    imports.push(`import { route as root } from "${rootPath.replace(/\\/g, "/")}";`);
  }

  for (let i = 0; i < routes.length; i++) {
    const route = routes[i] as ResolvedRoute;
    const pageName = `Page${i}`;

    imports.push(`import ${pageName} from "${route.path.replace(/\\/g, "/")}";`);

    const regexPattern = route.pattern.replace(/:[^/]+/g, "([^/]+)").replace(/\*/g, "(.*)");

    // Pass the page's route for runtime layout traversal
    routeEntries.push(
      `  { pattern: "${route.pattern}", regex: new RegExp("^${regexPattern}$"), component: ${pageName}.component, pageRoute: ${pageName}._route }`
    );
  }

  return `import { hydrateRoot } from "react-dom/client";
import { createElement } from "react";

${imports.join("\n")}

function collectLayouts(route) {
  const layouts = [];
  let current = route;
  while (current) {
    if (current.layout) {
      layouts.unshift(current.layout);
    }
    current = current.parent;
  }
  return layouts;
}

function injectSuppressHydration(element) {
  if (!element || typeof element !== 'object') return element;

  const type = element.type;
  const props = element.props || {};

  if (type === 'html' || type === 'head' || type === 'body') {
    const newProps = { ...props, suppressHydrationWarning: true };
    if (props.children) {
      newProps.children = Array.isArray(props.children)
        ? props.children.map(injectSuppressHydration)
        : injectSuppressHydration(props.children);
    }
    return Object.assign({}, element, { props: newProps });
  }

  if (props.children) {
    const newProps = { ...props };
    newProps.children = Array.isArray(props.children)
      ? props.children.map(injectSuppressHydration)
      : injectSuppressHydration(props.children);
    return Object.assign({}, element, { props: newProps });
  }

  return element;
}

const routes = [
${routeEntries.join(",\n")}
];

const pathname = window.location.pathname;
const match = routes.find(r => r.regex.test(pathname));

if (match) {
  const dataEl = document.getElementById("__ELYSION_DATA__");
  const loaderData = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};
  const rootEl = ${hasRoot ? "document" : "document.documentElement"};

  let element = createElement(match.component, loaderData);

  // Collect layouts from route chain (skipping root)
  const allLayouts = collectLayouts(match.pageRoute);
  const layouts = ${hasRoot ? "allLayouts.slice(1)" : "allLayouts"}; // Skip root if present

  for (let i = layouts.length - 1; i >= 0; i--) {
    const Layout = layouts[i];
    if (Layout) {
      element = createElement(Layout, { ...loaderData, children: element });
    }
  }

  ${
    hasRoot
      ? `
  if (root?.layout) {
    element = createElement(root.layout, { ...loaderData, children: element });
  }
  `
      : ""
  }

  // Inject suppressHydrationWarning to match SSR output
  element = injectSuppressHydration(element);

  hydrateRoot(rootEl, element);
} else {
  console.warn("[elysion] No matching route for", pathname);
}
`;
}

// ---------------------------------------------------------------------------
// Dev hydrate entry helpers
// ---------------------------------------------------------------------------

function buildDevRouteEntries(routes: ResolvedRoute[]): string[] {
  return routes.map((route) => {
    const pagesDir = findPagesDir(route.pagePath, route.pattern);
    const srcDir = join(pagesDir, "..");
    const relativeToSrc = relative(srcDir, route.pagePath).replace(/\\/g, "/");
    const regexPattern = route.pattern.replace(/:[^/]+/g, "([^/]+)").replace(/\*/g, "(.*)");

    return `  { pattern: "${route.pattern}", regex: new RegExp("^${regexPattern}$"), modulePath: "/src/${relativeToSrc}" }`;
  });
}

function buildLoadRootBlock(rootRelativePath: string): string {
  return `
async function loadRoot() {
  try {
    const mod = await import("/_modules/src/${rootRelativePath}");
    rootModule = mod.route || mod.default;
  } catch (err) {
    console.error("[hmr] Failed to load root layout:", err);
  }
}
`;
}

function buildHmrClientBlock(): string {
  return `
// --- HMR WebSocket Client ---
(function() {
  let ws = null;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 10;

  function connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(protocol + "//" + location.host + "/__elysion/hmr");

    ws.onopen = () => {
      console.log("[hmr] Connected");
      reconnectAttempts = 0;
    };

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        await handleMessage(data);
      } catch (err) {
        console.error("[hmr] Error handling message:", err);
      }
    };

    ws.onclose = () => {
      console.log("[hmr] Disconnected");
      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        setTimeout(connect, 1000 * reconnectAttempts);
      }
    };

    ws.onerror = (err) => {
      console.error("[hmr] WebSocket error:", err);
    };
  }

  let refreshTimeout = null;

  function scheduleRefresh() {
    if (refreshTimeout) clearTimeout(refreshTimeout);
    refreshTimeout = setTimeout(() => {
      refreshTimeout = null;
      performRefresh();
    }, 50);
  }

  function performRefresh() {
    // Re-render FIRST to transition hydrateRoot → createRoot before React Refresh
    // walks the root tree. Calling performReactRefresh() on a hydrateRoot-managed
    // root triggers hydration reconciliation → throwOnHydrationMismatch.
    reRenderCurrentPage().then(() => {
      try {
        RefreshRuntime.performReactRefresh();
      } catch (err) {
        console.error("[hmr] Fast Refresh swap failed:", err);
      }
    });
  }

  async function handleMessage(data) {
    if (data.type === "update") {
      console.log("[hmr] Update received:", data.path);

      hmrUpdateId++;
      for (const mod of data.modules || []) {
        const moduleId = "/_modules" + mod;
        const url = "/_modules" + mod + "?hmr=" + hmrUpdateId;
        console.log("[hmr] Re-importing:", url);

        window.__CURRENT_MODULE__ = moduleId;
        try {
          const newModule = await import(url);
          if (mod.includes("root.tsx") || mod === "/root.tsx") {
            ROOTMODULE_UPDATE
          } else {
            // Page modules contain their route chain, no separate handling needed
            window.__LATEST_PAGE_MODULE__ = newModule.default;
          }
        } catch (err) {
          console.error("[hmr] Module import failed:", err);
          location.reload();
          return;
        }
      }

      if (data.cssUpdate) {
        handleCssUpdate();
      }

      scheduleRefresh();
    } else if (data.type === "css-update") {
      console.log("[hmr] CSS update received:", data.path);
      handleCssUpdate();
    } else if (data.type === "reload") {
      location.reload();
    }
  }

  function handleCssUpdate() {
    const styleEl = document.getElementById("__elysion_css__");
    if (styleEl) {
      fetch("/__elysion/css?v=" + Date.now())
        .then((res) => res.text())
        .then((css) => {
          styleEl.textContent = css;
          console.log("[hmr] CSS updated (inline mode)");
        })
        .catch((err) => {
          console.error("[hmr] CSS update failed:", err);
        });
      return;
    }

    const linkEl = document.getElementById("__elysion_css_link__");
    if (linkEl) {
      const currentHref = linkEl.getAttribute("href") || "";
      const baseHref = currentHref.split("?")[0];
      linkEl.setAttribute("href", baseHref + "?v=" + Date.now());
      console.log("[hmr] CSS updated (external mode)");
      return;
    }

    console.log("[hmr] No CSS element found, reloading page");
    location.reload();
  }

  connect();
})();
`;
}

function generateDevHydrateEntry(routes: ResolvedRoute[], rootPath: string | null): string {
  const routeEntries = buildDevRouteEntries(routes);

  const clientModulePath = new URL("./client.ts", import.meta.url).pathname;
  const refreshRuntimePath = require.resolve("react-refresh/runtime");

  const hasRoot = rootPath !== null;
  const rootRelativePath =
    hasRoot && routes[0]
      ? (() => {
          const pagesDir = findPagesDir(routes[0].pagePath, routes[0].pattern);
          const srcDir = join(pagesDir, "..");
          return relative(srcDir, rootPath).replace(/\\/g, "/");
        })()
      : null;

  const rootModuleUpdate = hasRoot ? "rootModule = newModule.route || newModule.default;" : "";
  const hmrClientBlock = buildHmrClientBlock().replace("ROOTMODULE_UPDATE", rootModuleUpdate);

  return `import React from "react";
import { createElement } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import * as RefreshRuntime from "${refreshRuntimePath}";
import { createRoute } from "${clientModulePath}";

// Expose globals for transformed page modules
window.React = React;
window.__ELYSION__ = { createRoute };
window.__REFRESH_RUNTIME__ = RefreshRuntime;

// Initialize React Refresh
RefreshRuntime.injectIntoGlobalHook(window);

window.$RefreshReg$ = (type, id) => {
  const fullId = window.__CURRENT_MODULE__ + " " + id;
  RefreshRuntime.register(type, fullId);
};
window.$RefreshSig$ = RefreshRuntime.createSignatureFunctionForTransform;

console.log("[hmr] React Refresh initialized");

// Inject suppressHydrationWarning to match SSR output
function injectSuppressHydration(element) {
  if (!element || typeof element !== 'object') return element;

  const type = element.type;
  const props = element.props || {};

  if (type === 'html' || type === 'head' || type === 'body') {
    const newProps = { ...props, suppressHydrationWarning: true };
    if (props.children) {
      newProps.children = Array.isArray(props.children)
        ? props.children.map(injectSuppressHydration)
        : injectSuppressHydration(props.children);
    }
    return Object.assign({}, element, { props: newProps });
  }

  if (props.children) {
    const newProps = { ...props };
    newProps.children = Array.isArray(props.children)
      ? props.children.map(injectSuppressHydration)
      : injectSuppressHydration(props.children);
    return Object.assign({}, element, { props: newProps });
  }

  return element;
}

// Collect layouts from route chain
function collectLayouts(route) {
  const layouts = [];
  let current = route;
  while (current) {
    if (current.layout) {
      layouts.unshift(current.layout);
    }
    current = current.parent;
  }
  return layouts;
}

// Route map (generated at build time)
const routes = [
${routeEntries.join(",\n")}
];

// Global state
let reactRoot = null;
let isHydrationRoot = false;
let hmrUpdateId = 0;
${hasRoot ? "let rootModule = null;" : ""}

${hasRoot && rootRelativePath ? buildLoadRootBlock(rootRelativePath) : ""}

${hmrClientBlock}

// --- Fallback re-render ---
async function reRenderCurrentPage() {
  const pageModule = window.__LATEST_PAGE_MODULE__;
  if (!pageModule) return;

  const rootEl = ${hasRoot ? "document" : "document.documentElement"};
  const dataEl = document.getElementById("__ELYSION_DATA__");
  const loaderData = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};

  let element = createElement(pageModule.component, loaderData);

  // Collect and apply layouts from route chain
  const allLayouts = collectLayouts(pageModule._route);
  const layouts = ${hasRoot ? "allLayouts.slice(1)" : "allLayouts"}; // Skip root if present

  for (let i = layouts.length - 1; i >= 0; i--) {
    const Layout = layouts[i];
    if (Layout) {
      element = createElement(Layout, { ...loaderData, children: element });
    }
  }

  ${
    hasRoot
      ? `
  if (rootModule?.layout) {
    element = createElement(rootModule.layout, { ...loaderData, children: element });
  }
  `
      : ""
  }

  // Inject suppressHydrationWarning to match SSR output
  element = injectSuppressHydration(element);

  if (isHydrationRoot) {
    // First HMR after SSR: transition from hydrateRoot to createRoot
    if (reactRoot) reactRoot.unmount();
    reactRoot = createRoot(${hasRoot ? "document" : "document.documentElement"});
    isHydrationRoot = false;
  }
  reactRoot.render(element);
  console.log("[hmr] Manual re-render complete");
}

// --- Initial Hydration ---
async function hydrate() {
  ${hasRoot ? "await loadRoot();" : ""}

  const pathname = window.location.pathname;
  const match = routes.find(r => r.regex.test(pathname));

  if (!match) {
    console.warn("[hmr] No matching route for", pathname);
    return;
  }

  const modulePath = "/_modules" + match.modulePath;
  window.__CURRENT_MODULE__ = modulePath;

  try {
    const mod = await import(modulePath);
    const pageModule = mod.default;
    window.__LATEST_PAGE_MODULE__ = pageModule;

    const Component = pageModule.component;

    const dataEl = document.getElementById("__ELYSION_DATA__");
    const loaderData = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};

    const rootEl = ${hasRoot ? "document" : "document.documentElement"};

    let element = createElement(Component, loaderData);

    // Collect and apply layouts from route chain
    const allLayouts = collectLayouts(pageModule._route);
    const layouts = ${hasRoot ? "allLayouts.slice(1)" : "allLayouts"}; // Skip root if present

    for (let i = layouts.length - 1; i >= 0; i--) {
      const Layout = layouts[i];
      if (Layout) {
        element = createElement(Layout, { ...loaderData, children: element });
      }
    }

    ${
      hasRoot
        ? `
    if (rootModule?.layout) {
      element = createElement(rootModule.layout, { ...loaderData, children: element });
    }
    `
        : ""
    }

    // Inject suppressHydrationWarning to match SSR output
    element = injectSuppressHydration(element);

    reactRoot = hydrateRoot(rootEl, element);
    isHydrationRoot = true;
    console.log("[hmr] Hydrated successfully for route:", match.pattern);
  } catch (err) {
    console.error("[hmr] Hydration failed:", err);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", hydrate);
} else {
  hydrate();
}
`;
}

function findPagesDir(pagePath: string, _pattern: string): string {
  const pagesIdx = pagePath.lastIndexOf("/pages/");
  if (pagesIdx !== -1) {
    return pagePath.substring(0, pagesIdx + "/pages".length);
  }
  return pagePath.substring(0, pagePath.lastIndexOf("/"));
}
