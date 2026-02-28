import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedRoute } from "./router";
import { transformForClient } from "./transform-client";

export interface BuildClientOptions {
  dev?: boolean;
  outDir?: string;
  rootPath?: string | null;
}

const TS_FILE_FILTER = /\.(tsx|ts)$/;
const REACT_IMPORT_RE = /import\s+React\b/;

// ── Hydrate entry ──────────────────────────────────────────────────────────

/**
 * Generates the client hydration entry.
 *
 * Renders into <div id="root"> (the SSR outlet element) and retains the React
 * root across hot reloads via import.meta.hot.data.root so React Fast Refresh
 * applies in-place instead of remounting.
 */
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
    routeEntries.push(
      `  { pattern: "${route.pattern}", regex: new RegExp("^${regexPattern}$"), component: ${pageName}.component, pageRoute: ${pageName}._route }`
    );
  }

  return `import React from "react";
import { hydrateRoot, createRoot } from "react-dom/client";
import { createElement } from "react";

${imports.join("\n")}

const routes = [
${routeEntries.join(",\n")}
];

const pathname = window.location.pathname;
const match = routes.find((r) => r.regex.test(pathname));

if (match) {
  const dataEl = document.getElementById("__ELYSION_DATA__");
  const loaderData = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};
  const rootEl = document.getElementById("root");

  let element = createElement(match.component, loaderData);

  // Collect layout chain from the matched route upward (skip root at index 0)
  const allLayouts = [];
  let current = match.pageRoute;
  while (current) {
    if (current.layout) allLayouts.unshift(current.layout);
    current = current.parent;
  }
  const layouts = ${hasRoot ? "allLayouts.slice(1)" : "allLayouts"};

  for (let i = layouts.length - 1; i >= 0; i--) {
    const Layout = layouts[i];
    if (Layout) element = createElement(Layout, { ...loaderData, children: element });
  }

  ${
    hasRoot
      ? `if (root?.layout) {
    element = createElement(root.layout, { ...loaderData, children: element });
  }`
      : ""
  }

  if (import.meta.hot) {
    // Retain React root across hot reloads so Fast Refresh applies in-place.
    const hotRoot = (import.meta.hot.data.root ??= rootEl.innerHTML.trim()
      ? hydrateRoot(rootEl, element)
      : createRoot(rootEl));
    hotRoot.render(element);
  } else if (rootEl.innerHTML.trim()) {
    hydrateRoot(rootEl, element);
  } else {
    createRoot(rootEl).render(element);
  }
} else {
  console.warn("[elysion] No matching route for", pathname);
}
`;
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
export function generateIndexHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <!--ssr-head-->
  </head>
  <body>
    <div id="root"><!--ssr-outlet--></div>
    <script type="module" src="./_hydrate.tsx"></script>
  </body>
</html>
`;
}

/**
 * Writes _hydrate.tsx + index.html to outDir for dev (Bun HMR) mode.
 *
 * Only rewrites a file when its content has actually changed so Bun's --hot
 * watcher does not trigger a spurious reload on every server restart.
 */
export function writeDevFiles(routes: ResolvedRoute[], options: BuildClientOptions = {}): void {
  const { outDir = "./.elysion", rootPath = null } = options;

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

  console.log("[elysion] Dev files written (.elysion/_hydrate.tsx + .elysion/index.html)");
}

// ── Prod: full Bun.build() via HTML entrypoint ────────────────────────────

/**
 * Builds the production client bundle via Bun.build() using the generated
 * index.html as the HTML entrypoint.  Bun produces:
 *   .elysion/client/index.html  — processed template with hashed chunk paths
 *   .elysion/client/chunk-*.js  — code-split bundles
 *   .elysion/client/styles.css  — CSS (if imported)
 *
 * The output index.html is NOT served to browsers directly.  The server reads
 * it as an SSR template, injects the pre-rendered React HTML into
 * <!--ssr-outlet-->, and sends the complete page.
 */
export async function buildClient(
  routes: ResolvedRoute[],
  options: BuildClientOptions = {}
): Promise<void> {
  const { outDir = "./.elysion", rootPath = null } = options;
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

  console.log("[elysion] Building production client bundle…");

  const transformPlugin: Bun.BunPlugin = {
    name: "elysion-transform-client",
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

          return {
            contents: transformed,
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
    entrypoints: [indexPath],
    outdir: clientDir,
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    plugins: [transformPlugin],
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  });

  if (!result.success) {
    console.error("[elysion] Client build failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("Client build failed");
  }

  for (const output of result.outputs) {
    console.log(`[elysion]   ${output.path} (${(output.size / 1024).toFixed(1)} KB)`);
  }

  console.log("[elysion] Production client build complete");
}
