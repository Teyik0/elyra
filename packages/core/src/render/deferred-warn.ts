/**
 * Warns once per route+mode when a page loader returns `defer()` while being
 * rendered in a static context (SSG / ISR).
 *
 * In SSG/ISR, the static adapter awaits every Promise in `toCrossJSONAsync`
 * before producing the cached `.ndjson` — so `defer()` loses its streaming
 * property and effectively behaves like an eager loader. This is a DX trap
 * (the developer thinks the page is progressively streaming when it isn't),
 * so we surface a one-shot warning per route.
 */

const warned = new Set<string>();

export function warnDeferredInStaticContext(routePattern: string, mode: "isr" | "ssg"): void {
  const key = `${routePattern}|${mode}`;
  if (warned.has(key)) {
    return;
  }
  warned.add(key);
  console.warn(
    `[furin] page "${routePattern}" returns defer() but is rendered in "${mode}" mode — deferred Promises are resolved eagerly before the page is cached, so streaming has no effect. Either drop defer() or switch the route to SSR.`
  );
}

/**
 * Test-only: clears the dedup memory so each test starts from a clean slate.
 * Not exported from the public package entry.
 */
export function __resetDeferredStaticWarnings(): void {
  warned.clear();
}
