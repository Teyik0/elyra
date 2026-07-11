export type SearchParamValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | SearchParamValue[]
  | { [key: string]: SearchParamValue };

export interface SearchParamsInput {
  [key: string]: SearchParamValue;
}

export interface SearchRouteMetadata {
  pattern: string;
  regex: RegExp;
  searchDefaults?: SearchParamsInput;
}

function routeSegmentSpecificity(segment: string): number {
  if (segment === "*") {
    return 1;
  }
  if (segment.startsWith(":")) {
    return 2;
  }
  return 3;
}

function compareSearchRouteSpecificity(a: string, b: string): number {
  const aSegments = a.split("/").filter((segment) => segment.length > 0);
  const bSegments = b.split("/").filter((segment) => segment.length > 0);
  const length = Math.max(aSegments.length, bSegments.length);
  for (let i = 0; i < length; i++) {
    const aSegment = aSegments[i];
    const bSegment = bSegments[i];
    if (aSegment === undefined) {
      return -1;
    }
    if (bSegment === undefined) {
      return 1;
    }
    const diff = routeSegmentSpecificity(aSegment) - routeSegmentSpecificity(bSegment);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function isObject(value: unknown): value is { [key: string]: unknown } {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function arraysDeepEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (!deepEqual(a[i], b[i])) {
      return false;
    }
  }
  return true;
}

function objectsDeepEqual(a: { [key: string]: unknown }, b: { [key: string]: unknown }): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) {
    return false;
  }
  for (const key of aKeys) {
    if (!(Object.hasOwn(b, key) && deepEqual(a[key], b[key]))) {
      return false;
    }
  }
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return arraysDeepEqual(a, b);
  }
  if (isObject(a) && isObject(b)) {
    return objectsDeepEqual(a, b);
  }
  return false;
}

export function stripSearchDefaults(
  search: SearchParamsInput,
  defaults: SearchParamsInput | undefined
): SearchParamsInput {
  if (!defaults) {
    return search;
  }
  const stripped: SearchParamsInput = {};
  for (const [key, value] of Object.entries(search)) {
    if (Object.hasOwn(defaults, key) && deepEqual(value, defaults[key])) {
      continue;
    }
    stripped[key] = value;
  }
  return stripped;
}

export function appendSearchParamValue(params: URLSearchParams, key: string, value: unknown): void {
  if (value == null) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (item != null) {
        params.append(key, typeof item === "object" ? JSON.stringify(item) : String(item));
      }
    }
    return;
  }

  params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
}

export function buildSearchParams(
  search: SearchParamsInput,
  defaults?: SearchParamsInput
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(stripSearchDefaults(search, defaults))) {
    appendSearchParamValue(params, key, value);
  }
  return params;
}

export function collectSearchDefaults(schema: unknown): SearchParamsInput | undefined {
  if (!(isObject(schema) && isObject(schema.properties))) {
    return;
  }

  const defaults: SearchParamsInput = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    if (isObject(value) && Object.hasOwn(value, "default") && value.default !== null) {
      defaults[key] = value.default as SearchParamValue;
    }
  }

  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

export function findSearchDefaults(
  pathname: string,
  routes: readonly SearchRouteMetadata[]
): SearchParamsInput | undefined {
  let match: SearchRouteMetadata | undefined;
  for (const route of routes) {
    if (!route.regex.test(pathname)) {
      continue;
    }
    if (!match || compareSearchRouteSpecificity(route.pattern, match.pattern) > 0) {
      match = route;
    }
  }
  return match?.searchDefaults;
}

export function findSearchDefaultsForRouteTarget(
  to: string,
  routes: readonly SearchRouteMetadata[]
): SearchParamsInput | undefined {
  if (to.startsWith("http://") || to.startsWith("https://") || to.startsWith("//")) {
    return;
  }
  try {
    const pathname = new URL(to, "http://furin.local").pathname;
    return findSearchDefaults(pathname, routes);
  } catch {
    // Invalid route targets have no search defaults.
  }
}
