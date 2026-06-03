import { parse } from "node:path";
import type { RuntimePage, RuntimeRoute } from "../../client.ts";

export function collectIntermediateLayoutDirs(pagePath: string, rootPath: string): string[] {
  const pageDir = pagePath.slice(0, pagePath.lastIndexOf("/"));
  const pagesDir = rootPath.slice(0, rootPath.lastIndexOf("/"));
  const layoutDirs: string[] = [];
  let dir = pageDir;

  while (dir.length > pagesDir.length) {
    layoutDirs.unshift(dir);
    dir = dir.slice(0, dir.lastIndexOf("/"));
  }

  return layoutDirs;
}

export function resolveMode(page: RuntimePage, routeChain: RuntimeRoute[]): "ssr" | "ssg" | "isr" {
  const routeConfig = page._route;
  const mode = routeConfig.mode ?? (page as { mode?: string }).mode;
  const revalidate = routeConfig.revalidate ?? (page as { revalidate?: number }).revalidate;

  if (mode) {
    return mode as "ssr" | "ssg" | "isr";
  }

  const hasLoader = routeChain.some((r) => r.loader) || !!page.loader;

  if (!hasLoader) {
    return "ssg";
  }

  if (typeof revalidate === "number" && revalidate >= 0) {
    return "isr";
  }

  return "ssr";
}

export function filePathToPattern(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/");
  const segments: string[] = [];

  for (const part of parts) {
    const name = parse(part).name;

    if (name === "index") {
      continue;
    }

    if (name.startsWith("[") && name.endsWith("]")) {
      const inner = name.slice(1, -1);

      if (inner.startsWith("...")) {
        segments.push("*");
        continue;
      }

      segments.push(`:${inner}`);
      continue;
    }

    segments.push(name);
  }

  return `/${segments.join("/")}`;
}

const REGEX_META_CHARS_RE = /[.*+?^${}()|[\]\\]/;

export function escapeRegExpChar(ch: string): string {
  return REGEX_META_CHARS_RE.test(ch) ? `\\${ch}` : ch;
}

/**
 * Scores how specific a route pattern is so the `/_furin/data` matcher can
 * prefer a static route over a dynamic sibling that also matches. Per segment:
 * a literal segment outranks a `:param`, which outranks a `*` wildcard.
 */
export function routeSpecificity(pattern: string): number {
  let score = 0;
  for (const segment of pattern.split("/")) {
    if (segment.length === 0) {
      continue;
    }
    if (segment === "*") {
      score += 1;
    } else if (segment.startsWith(":")) {
      score += 2;
    } else {
      score += 3;
    }
  }
  return score;
}

/**
 * Builds a regex from a route pattern, extracts named capture groups for
 * each `:param` segment, and returns `{ regex, paramNames }`.
 *
 * Literal characters (e.g. dots in filenames like `v1.0`) are escaped so
 * they are matched exactly rather than interpreted as regex syntax.
 */
export function buildRouteRegex(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  let source = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === ":") {
      const start = ++i;
      while (i < pattern.length && pattern[i] !== "/") {
        i++;
      }
      paramNames.push(pattern.slice(start, i));
      source += "([^/]+)";
    } else if (pattern[i] === "*") {
      paramNames.push("*");
      source += "(.*)";
      i++;
    } else {
      const ch = pattern[i];
      if (ch !== undefined) {
        source += escapeRegExpChar(ch);
      }
      i++;
    }
  }
  return { regex: new RegExp(`^${source}$`), paramNames };
}
