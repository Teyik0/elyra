import { resolve } from "node:path";
import type { RuntimePage, RuntimeRoute } from "./client";

export function validatePathWithinDir(path: string, dir: string): void {
  const resolvedPath = resolve(path);
  const resolvedDir = resolve(dir);
  if (!resolvedPath.startsWith(resolvedDir)) {
    throw new Error(`Path traversal detected: ${path} is outside ${dir}`);
  }
}

export function isElysionPage(value: unknown): value is RuntimePage {
  return (
    typeof value === "object" &&
    value !== null &&
    "__type" in value &&
    (value as { __type: unknown }).__type === "ELYSION_PAGE"
  );
}

export function isElysionRoute(value: unknown): value is RuntimeRoute {
  return (
    typeof value === "object" &&
    value !== null &&
    "__type" in value &&
    (value as { __type: unknown }).__type === "ELYSION_ROUTE"
  );
}

export function collectRouteChainFromRoute(route: RuntimeRoute | undefined): RuntimeRoute[] {
  const chain: RuntimeRoute[] = [];
  let current = route;

  while (current) {
    chain.unshift(current);
    current = current.parent;
  }

  return chain;
}

export function collectRouteChain(page: RuntimePage | undefined): RuntimeRoute[] {
  if (!page) {
    return [];
  }
  return collectRouteChainFromRoute(page._route);
}

export function hasCycle(route: RuntimeRoute): boolean {
  const visited = new Set<RuntimeRoute>();
  let current: RuntimeRoute | undefined = route;

  while (current) {
    if (visited.has(current)) {
      return true;
    }
    visited.add(current);
    current = current.parent;
  }

  return false;
}

export function validateRouteChain(
  chain: RuntimeRoute[],
  root: RuntimeRoute | null,
  pagePath?: string
): void {
  if (!root) {
    throw new Error(
      "[elysion] No root layout found. Create a root.tsx file with a createRoute() that includes a layout."
    );
  }

  const hasRoot = chain.some((r) => r === root);

  if (!hasRoot) {
    const location = pagePath ? ` in ${pagePath}` : "";
    throw new Error(
      `[elysion] Page${location} must inherit from root route. ` +
        'Add: import { route } from "./root"; and use route.page() or set parent: route'
    );
  }

  for (const route of chain) {
    if (hasCycle(route)) {
      throw new Error(
        "[elysion] Cycle detected in route chain. A route cannot be its own ancestor."
      );
    }
  }
}
