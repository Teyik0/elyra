import { relative } from "node:path";
import type { TSchema } from "elysia";
import type { TypeCheck } from "elysia/type-system";
import type { ServerWebSocket } from "elysia/ws/bun";
import { transformForReactRefresh } from "./transform";

type HmrClient = ServerWebSocket<{
  id?: string | undefined;
  validator?: TypeCheck<TSchema> | undefined;
}>;

// WebSocket clients — persisted across hot reloads via import.meta.hot.data.
// This is a true server singleton (live connections), not HMR infrastructure.
const clients: Set<HmrClient> = (import.meta.hot.data.clients ??= new Set<HmrClient>());

// Per-file version counters — persisted across hot reloads.
// Incremented by the file watcher so SSR always uses the latest module version
// without creating a new cache entry on every request (which would leak memory).
const moduleVersions: Map<string, number> = (import.meta.hot.data.moduleVersions ??= new Map<
  string,
  number
>());

// Cache for pre-built non-page modules (e.g. src/client.ts that import npm packages).
// Bun.build() can fail with EISDIR when resolving packages from Bun's .bun/ cache;
// caching avoids repeated failed builds and expensive re-bundling per request.
const builtModuleCache: Map<string, string> = (import.meta.hot.data.builtModuleCache ??= new Map<
  string,
  string
>());

export function getModuleVersion(absolutePath: string): number {
  return moduleVersions.get(absolutePath) ?? 0;
}

export function invalidateModuleCache(absolutePath: string): void {
  moduleVersions.set(absolutePath, (moduleVersions.get(absolutePath) ?? 0) + 1);
}

export function getHmrClients(): Set<HmrClient> {
  return clients;
}

export function broadcastMessage(message: string): void {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

export async function getTransformedModule(
  fullPath: string,
  srcDir: string,
  pagesDir: string
): Promise<string> {
  const file = Bun.file(fullPath);
  if (!(await file.exists())) {
    throw new Error(`File not found: ${fullPath}`);
  }

  const relativePath = relative(srcDir, fullPath).replace(/\\/g, "/");
  const moduleId = `/_modules/src/${relativePath}`;

  // Non-page files (e.g. client utilities) may import bare module specifiers
  // (like @elysiajs/eden) that the browser cannot resolve without a bundler.
  // Bundle them with Bun.build() so all dependencies are inlined as ESM.
  //
  // React and react-dom are marked external: they live in Bun's .bun/ local
  // cache which is not seekable by Bun.build() at runtime. The HMR hydrate
  // entry already exposes window.React = React, so page-side utilities that
  // use React can rely on that global instead of bundling a second copy.
  //
  // Results are cached per-file: Bun.build() can fail with EISDIR when
  // resolving packages from Bun's .bun/ cache (a directory is read as a file).
  // Caching avoids repeated failures and expensive re-bundling per request.
  if (relative(pagesDir, fullPath).startsWith("..")) {
    const cached = builtModuleCache.get(fullPath);
    if (cached) {
      return cached;
    }

    const result = await Bun.build({
      entrypoints: [fullPath],
      format: "esm",
      target: "browser",
      // Use the full browser conditions order to avoid Bun resolving packages
      // from its .bun/ internal cache (where some entries are directories,
      // not files, causing EISDIR errors).
      conditions: ["browser", "import", "module", "default"],
      splitting: false,
      minify: false,
      external: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
      ],
    });

    if (!result.success) {
      const messages = result.logs.map((l) => l.message).join("\n");
      throw new Error(`Bun.build() failed for ${fullPath}:\n${messages}`);
    }

    const output = result.outputs[0];
    if (!output) {
      throw new Error(`Bun.build() produced no output for ${fullPath}`);
    }

    const code = await output.text();
    builtModuleCache.set(fullPath, code);
    return code;
  }

  const source = await file.text();
  return transformForReactRefresh(source, fullPath, moduleId, srcDir, pagesDir);
}

// HMR lifecycle — persist clients, module versions, and built module cache across hot reloads.
import.meta.hot.dispose((data) => {
  data.clients = clients;
  data.moduleVersions = moduleVersions;
  data.builtModuleCache = builtModuleCache;
});
