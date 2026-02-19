import { watch } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { TSchema } from "elysia";
import type { TypeCheck } from "elysia/type-system";
import type { ServerWebSocket } from "elysia/ws/bun";
import { getCssConfig, invalidateCssCache } from "../css";
import { transformForReactRefresh } from "./transform";

// Global state (survives bun --hot reloads)
declare global {
  var __elysionHmrClients: Set<
    ServerWebSocket<{ id?: string | undefined; validator?: TypeCheck<TSchema> | undefined }>
  >;
  var __elysionHmrWatchers: ReturnType<typeof watch>[];
  var __elysionModuleCache: Map<string, { code: string; timestamp: number }>;
  var __elysionModuleVersions: Map<string, number>;
}

globalThis.__elysionHmrClients ??= new Set();
globalThis.__elysionHmrWatchers ??= [];
// Reset module cache on hot reload so transform changes take effect
globalThis.__elysionModuleCache = new Map();
// Module versions for SSR cache-busting (persists across hot reloads)
globalThis.__elysionModuleVersions ??= new Map();

export function getHmrClients(): Set<
  ServerWebSocket<{ id?: string | undefined; validator?: TypeCheck<TSchema> | undefined }>
> {
  return globalThis.__elysionHmrClients;
}

export function getModuleVersion(fullPath: string): number {
  return globalThis.__elysionModuleVersions.get(fullPath) ?? 0;
}

function invalidateCssCacheIfNeeded(): void {
  const config = getCssConfig();
  if (config) {
    const absolutePath = resolve(process.cwd(), config.input);
    invalidateCssCache(absolutePath);
  }
}

export function setupHmrWatcher(pagesDir: string, cssInputPath?: string) {
  const srcDir = dirname(pagesDir);

  // Close existing watchers
  for (const w of globalThis.__elysionHmrWatchers) {
    try {
      w.close();
    } catch {
      // Watcher may already be closed
    }
  }
  globalThis.__elysionHmrWatchers = [];

  const recentlyBroadcast = new Map<string, number>();

  // Watch pages directory
  const pagesWatcher = watch(pagesDir, { recursive: true }, (event, filename) => {
    if (!filename) {
      return;
    }
    if (!(filename.endsWith(".tsx") || filename.endsWith(".ts"))) {
      return;
    }

    // Debounce: fs.watch on macOS fires duplicate events
    const now = Date.now();
    const last = recentlyBroadcast.get(filename) || 0;
    if (now - last < 100) {
      return;
    }
    recentlyBroadcast.set(filename, now);

    const fullPath = resolve(pagesDir, filename);
    console.log(`[hmr] File ${event}: ${filename}`);

    // Invalidate module cache
    globalThis.__elysionModuleCache.delete(fullPath);

    // Increment version for SSR cache-busting
    const currentVersion = globalThis.__elysionModuleVersions.get(fullPath) ?? 0;
    globalThis.__elysionModuleVersions.set(fullPath, currentVersion + 1);

    // Invalidate CSS cache since Tailwind classes might have changed
    invalidateCssCacheIfNeeded();

    // Always use "update" — the client handles layout (route.tsx) and page updates the same way.
    // route.tsx layouts update layoutModuleCache in the client; no full reload needed.
    const messageType = "update";

    // Normalize to POSIX separators for valid URLs (Windows compatibility)
    const normalizedFilename = filename.replace(/\\/g, "/");

    // Use /_modules/src/pages/ URL scheme so rewritten relative imports resolve correctly
    const relativeToSrc = relative(srcDir, fullPath).replace(/\\/g, "/");

    const message = JSON.stringify({
      type: messageType,
      path: `/src/pages/${normalizedFilename}`,
      modules: [`/src/${relativeToSrc}`],
      cssUpdate: true, // Signal that CSS might have changed
    });

    for (const client of globalThis.__elysionHmrClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }

    console.log(
      `[hmr] Broadcast ${messageType} to ${globalThis.__elysionHmrClients.size} client(s)`
    );
  });

  globalThis.__elysionHmrWatchers.push(pagesWatcher);
  console.log("[hmr] File watcher started for pages");

  // Watch CSS file if configured
  if (cssInputPath) {
    const absoluteCssPath = resolve(process.cwd(), cssInputPath);
    const cssDir = dirname(absoluteCssPath);

    const cssWatcher = watch(cssDir, { recursive: true }, (event, filename) => {
      if (!filename) {
        return;
      }

      // Check if the changed file is our CSS file
      const changedPath = resolve(cssDir, filename);
      if (changedPath !== absoluteCssPath && !filename.endsWith(".css")) {
        return;
      }

      // Debounce
      const now = Date.now();
      const last = recentlyBroadcast.get(filename) || 0;
      if (now - last < 100) {
        return;
      }
      recentlyBroadcast.set(filename, now);

      console.log(`[hmr] CSS file ${event}: ${filename}`);

      // Invalidate CSS cache
      invalidateCssCache(absoluteCssPath);

      // Broadcast CSS update
      const message = JSON.stringify({
        type: "css-update",
        path: filename,
      });

      for (const client of globalThis.__elysionHmrClients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      }

      console.log(`[hmr] Broadcast css-update to ${globalThis.__elysionHmrClients.size} client(s)`);
    });

    globalThis.__elysionHmrWatchers.push(cssWatcher);
    console.log("[hmr] CSS watcher started");
  }
}

export async function getTransformedModule(fullPath: string, srcDir: string, pagesDir: string): Promise<string> {
  const cached = globalThis.__elysionModuleCache.get(fullPath);
  if (cached) {
    return cached.code;
  }

  const file = Bun.file(fullPath);
  if (!(await file.exists())) {
    throw new Error(`File not found: ${fullPath}`);
  }

  const source = await file.text();
  const relativePath = relative(srcDir, fullPath).replace(/\\/g, "/");
  const moduleId = `/_modules/src/${relativePath}`;
  const transformed = transformForReactRefresh(source, fullPath, moduleId, srcDir, pagesDir);

  globalThis.__elysionModuleCache.set(fullPath, {
    code: transformed,
    timestamp: Date.now(),
  });

  return transformed;
}

export function cleanupWatchers() {
  for (const watcher of globalThis.__elysionHmrWatchers) {
    watcher.close();
  }
  globalThis.__elysionHmrWatchers = [];
}
