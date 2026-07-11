// Naming helpers shared between the runtime (furin.ts) and the build
// pipeline (adapter/bun.ts) — both must agree on where a mounted app's
// client assets live on disk.

/**
 * On-disk client dir name for a mounted app: the root instance keeps the
 * historical `client/`, prefixed instances get `client-<slug>/` next to it.
 */
export function clientDirNameForPrefix(prefix: string): string {
  return prefix === "" ? "client" : `client-${prefixSlug(prefix)}`;
}

/** Filesystem-safe slug for a mount prefix (`/admin/v2` → `admin-v2`). */
export function prefixSlug(prefix: string): string {
  return prefix.slice(1).replaceAll("/", "-");
}
