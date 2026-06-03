import { Elysia } from "elysia";
import {
  type DevLoaderCacheEntry,
  getAllDevISRLoaderEntries,
  getAllDevSSGLoaderEntries,
  isDevLoaderCacheFresh,
} from "./cache/dev-loader.ts";

/**
 * Dev "Live ISR" inspector.
 *
 * Mounts read-only JSON endpoints that surface the active entries of the
 * dev-mode loader caches.  Designed to back a future browser DevTools panel:
 * the JSON shape is stable and carries enough information for a UI to render
 * a freshness-aware entry list with dependencies and a data preview.
 *
 * The plugin always registers the routes — caller is responsible for gating
 * on `IS_DEV` to keep them out of production builds.
 */

/** Public response shape — keep stable for downstream UI consumers. */
export interface InspectorEntry {
  /** Per-entry preview of the cached loader output. */
  dataPreview: Record<string, unknown>;
  /** Source files whose change drops this entry. */
  dependencies: string[];
  /** ms timestamp at which the entry was written. */
  generatedAt: number;
  /** True iff the entry is still within its `revalidate` window. */
  isFresh: boolean;
  /** Resolved cache key (the same path used by `revalidatePath`). */
  key: string;
  /** Cache origin — surfaced verbatim so a UI can group by mode. */
  mode: "isr" | "ssg";
  /** Revalidate window in seconds.  SSG entries report `-1` for "indefinite". */
  revalidate: number;
}

function projectEntry(key: string, entry: DevLoaderCacheEntry): InspectorEntry {
  const revalidate = Number.isFinite(entry.revalidate) ? entry.revalidate : -1;
  return {
    dataPreview: entry.loaderData,
    dependencies: entry.dependencies,
    generatedAt: entry.generatedAt,
    isFresh: isDevLoaderCacheFresh(entry),
    key,
    mode: entry.mode,
    revalidate,
  };
}

export function createDevInspectorPlugin() {
  return new Elysia({ name: "furin-dev-inspector" })
    .get("/__furin/_inspect/isr", () =>
      getAllDevISRLoaderEntries().map(([key, entry]) => projectEntry(key, entry))
    )
    .get("/__furin/_inspect/ssg", () =>
      getAllDevSSGLoaderEntries().map(([key, entry]) => projectEntry(key, entry))
    );
}
