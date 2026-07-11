import type { SsgCacheEntry } from "./cache/index.ts";
import { __clearInstanceRegistry } from "./instance.ts";

// ── Compile-time context for compiled binaries ──────────────────────────────
// The generated compile entry calls `__setCompileContext()` before importing
// server.ts. At runtime, `router.ts` and `furin.ts` use `getCompileContext()`
// to resolve modules and assets from the binary instead of the filesystem.

export interface EmbeddedAppData {
  assets: Record<string, string>;
  template: string;
}

export interface CompileContextRoute {
  mode: "ssr" | "ssg" | "isr";
  path: string;
  pattern: string;
}

export interface CompileContext {
  buildId?: string;
  embedded?: EmbeddedAppData;
  modules: Record<string, unknown>;
  /** Mount prefix this app was built for (`""` = root). */
  prefix?: string;
  /** Root-level conventions discovered at compile time. */
  rootConventions?: { errorPath?: string; notFoundPath?: string };
  rootPath: string;
  /** Per-route metadata including pre-computed segment boundaries. */
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
  routes: CompileContextRoute[];
  ssgCache?: Record<string, SsgCacheEntry>;
}

// Contexts are keyed by their pagesDir (the directory containing root.tsx),
// normalized to posix separators. Several packaged furin apps can each ship a
// self-registering module calling `__setCompileContext()` — registration is
// ADDITIVE, one context per app.
const _compileContexts = new Map<string, CompileContext>();

function normalizeContextKey(path: string): string {
  return path.replaceAll("\\", "/");
}

function pagesDirOf(ctx: CompileContext): string {
  const rootPath = normalizeContextKey(ctx.rootPath);
  const lastSlash = rootPath.lastIndexOf("/");
  return lastSlash === -1 ? rootPath : rootPath.slice(0, lastSlash);
}

export function __setCompileContext(ctx: CompileContext): void {
  _compileContexts.set(pagesDirOf(ctx), ctx);
}

/**
 * Looks up the compile context for `pagesDir`. Without an argument — or when
 * the keyed lookup misses and exactly one context exists — returns the sole
 * registered context (single-app back-compat).
 */
export function getCompileContext(pagesDir?: string, prefix?: string): CompileContext | null {
  if (pagesDir !== undefined) {
    const keyed = _compileContexts.get(normalizeContextKey(pagesDir));
    if (keyed) {
      return keyed;
    }
  }
  // Deployed binaries run from a different cwd than the build — the absolute
  // pagesDir key misses there, but the mount prefix is stable across machines.
  if (prefix !== undefined) {
    for (const ctx of _compileContexts.values()) {
      if ((ctx.prefix ?? "") === prefix) {
        return ctx;
      }
    }
  }
  if (_compileContexts.size === 1) {
    return _compileContexts.values().next().value ?? null;
  }
  return null;
}

export function getAllCompileContexts(): ReadonlyMap<string, CompileContext> {
  return _compileContexts;
}

export function __resetCompileContext(): void {
  _compileContexts.clear();
  // A test tearing down compile contexts is tearing down its furin mounts —
  // forget their prefix registrations too so the next test mounts cleanly.
  __clearInstanceRegistry();
}
