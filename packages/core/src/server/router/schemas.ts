import type { Context } from "elysia";
import { t } from "elysia";
import { parseQueryFromURL, parseQueryStandardSchema } from "elysia/parse-query";
import { getSchemaValidator } from "elysia/schema";
import type { AnySchema } from "elysia/types";
import type { RuntimeRoute } from "../../client.ts";
import { appendSearchParamValue } from "../../shared/search-params.ts";

interface UnknownObject {
  [key: string]: unknown;
}

interface QueryKeyMap {
  [key: string]: 1;
}

// ── Query-default redirect ──────────────────────────────────────────────────
// Validator-agnostic: after Elysia applies defaults (TypeBox, Zod, Valibot…),
// compare the raw URL query keys with the resolved ctx.query keys. If ctx.query
// contains keys absent from the URL, defaults were applied → 302 redirect to
// the canonical URL so the address bar always reflects the actual app state.

/**
 * Detects whether a validator filled in default query values that the original
 * URL did not carry, and returns the canonical `pathname + search` to redirect
 * to — or `undefined` when the URL already reflects the resolved query.
 *
 * Pure helper extracted from `queryDefaultRedirectHook` so the `/_furin/data`
 * NDJSON endpoint can detect the same condition without going through
 * Elysia's `status()` shim (which only emits HTTP 302s, unparseable by the
 * SPA client).
 *
 * @internal Exported for unit testing.
 */
export function detectQueryDefaultRedirect(
  request: Request,
  resolvedQuery: UnknownObject
): string | undefined {
  const queryKeys = Object.keys(resolvedQuery);
  if (queryKeys.length === 0) {
    return;
  }

  const rawParams = new URL(request.url).searchParams;
  let needsRedirect = false;
  for (const key of queryKeys) {
    if (!rawParams.has(key) && resolvedQuery[key] != null) {
      needsRedirect = true;
      break;
    }
  }
  if (!needsRedirect) {
    return;
  }

  const url = new URL(request.url);
  for (const [k, v] of Object.entries(resolvedQuery)) {
    url.searchParams.delete(k);
    appendSearchParamValue(url.searchParams, k, v);
  }
  return url.pathname + url.search;
}

/**
 * Parses the `?path=` argument of `/_furin/data`, rejecting absolute /
 * protocol-relative inputs that would let a caller smuggle a foreign origin
 * into the synthetic loader request.
 *
 * Returns `{ url, pathname }` on success, or `undefined` when the input is
 * unsafe (the caller should reply 400). `new URL(rawPath, base)` ignores the
 * base when `rawPath` is itself absolute, so without these prefix and origin
 * checks a value like `https://evil.com/foo` would propagate to
 * `syntheticRequest.url`.
 *
 * @internal Exported for unit testing.
 */
export function parseDataEndpointPath(rawPath: string): { url: URL; pathname: string } | undefined {
  if (rawPath.includes("://") || rawPath.startsWith("//")) {
    return;
  }
  let url: URL;
  try {
    url = new URL(rawPath, "http://localhost");
  } catch {
    return;
  }
  if (url.origin !== "http://localhost") {
    return;
  }
  return { url, pathname: url.pathname };
}

function isObjectSchema(schema: unknown): schema is UnknownObject {
  return !!schema && typeof schema === "object";
}

function isStandardSchema(schema: unknown): boolean {
  return isObjectSchema(schema) && "~standard" in schema;
}

function collectQueryArrayKeys(schema: unknown): QueryKeyMap | undefined {
  if (!(isObjectSchema(schema) && isObjectSchema(schema.properties))) {
    return;
  }

  const keys: QueryKeyMap = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    if (isObjectSchema(value) && value.type === "array") {
      keys[key] = 1;
    }
  }

  return Object.keys(keys).length > 0 ? keys : undefined;
}

function collectQueryObjectKeys(schema: unknown): QueryKeyMap | undefined {
  if (!(isObjectSchema(schema) && isObjectSchema(schema.properties))) {
    return;
  }

  const keys: QueryKeyMap = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    if (isObjectSchema(value) && value.type === "object") {
      keys[key] = 1;
    }
  }

  return Object.keys(keys).length > 0 ? keys : undefined;
}

function parseJsonQueryObjects(
  query: UnknownObject,
  objectKeys: QueryKeyMap | undefined
): UnknownObject {
  if (!objectKeys) {
    return query;
  }

  const parsed = { ...query };
  for (const key of Object.keys(objectKeys)) {
    const value = parsed[key];
    if (typeof value !== "string") {
      continue;
    }
    try {
      parsed[key] = JSON.parse(value);
    } catch {
      parsed[key] = value;
    }
  }
  return parsed;
}

export type ParseRouteQueryResult =
  | { ok: true; query: UnknownObject }
  | { errors: unknown; ok: false };

/**
 * Parses and validates a logical route URL's search string for the synthetic
 * `/_furin/data` request path. This keeps SPA navigations aligned with the
 * Elysia guard used by the full SSR route.
 *
 * @internal Exported for unit testing.
 */
export async function parseRouteQuery(
  url: URL,
  schema: AnySchema | undefined
): Promise<ParseRouteQueryResult> {
  if (!schema) {
    return { ok: true, query: parseQueryStandardSchema(url.search, 1) as UnknownObject };
  }

  if (isStandardSchema(schema)) {
    const rawQuery = parseQueryStandardSchema(url.search, 1) as UnknownObject;
    const validator = getSchemaValidator(schema, { dynamic: true });
    const checked = await validator?.Check(rawQuery);
    if (checked && typeof checked === "object" && "issues" in checked) {
      return { errors: checked.issues, ok: false };
    }
    if (checked && typeof checked === "object" && "value" in checked) {
      return { ok: true, query: checked.value as UnknownObject };
    }
    return { ok: true, query: rawQuery };
  }

  const rawQuery = parseJsonQueryObjects(
    parseQueryFromURL(url.search, 1, collectQueryArrayKeys(schema)) as UnknownObject,
    collectQueryObjectKeys(schema)
  );
  const queryWithDefaults = applySchemaDefaults(schema as UnknownObject, rawQuery);
  const validator = getSchemaValidator(schema, { coerce: true, dynamic: true });
  if (validator?.Check(queryWithDefaults) === false) {
    return { errors: [...(validator?.Errors(queryWithDefaults) ?? [])], ok: false };
  }

  return {
    ok: true,
    query: (validator?.parse(queryWithDefaults) ?? queryWithDefaults) as UnknownObject,
  };
}

/** @internal Exported for unit testing. */
export function queryDefaultRedirectHook({ request, query, status, set }: Context) {
  const location = detectQueryDefaultRedirect(request, query as UnknownObject);
  if (!location) {
    return;
  }
  set.headers.location = location;
  return status("Found");
}

// Standard structural keys on a TObject — everything else is a user-supplied option
// (e.g. additionalProperties, $id, description, title) and must be preserved.
const TOBJECT_STRUCTURAL_KEYS = new Set(["type", "properties", "required"]);

/**
 * Merges TObject schemas from all routeChain entries for a given key.
 * Properties are spread left-to-right (leaf wins on key conflict).
 * Object-level options (additionalProperties, $id, description, …) are also
 * merged with the same leaf-wins semantics so they are not silently dropped.
 * Returns undefined when no entry in the chain defines the key.
 *
 * @internal Exported for unit testing.
 */
export function mergeRouteSchemas(
  routeChain: RuntimeRoute[],
  key: "params" | "query"
): AnySchema | undefined {
  const schemas = routeChain.flatMap((r) => (r[key] ? [r[key]] : [])) as Record<string, unknown>[];

  if (schemas.length === 0) {
    return;
  }
  if (schemas.length === 1) {
    return schemas[0] as AnySchema;
  }

  if (schemas.some((s) => !s.properties || typeof s.properties !== "object")) {
    throw new Error(
      `[furin] Merging ${key} schemas across the route chain requires TypeBox in V1. Use TypeBox for parent/child ${key}, or define ${key} only on leaf routes.`
    );
  }

  const mergedProperties = Object.assign(
    {},
    ...schemas.map((s) => (s.properties as Record<string, unknown>) ?? {})
  );

  const mergedOptions = Object.assign(
    {},
    ...schemas.map((s) =>
      Object.fromEntries(Object.entries(s).filter(([k]) => !TOBJECT_STRUCTURAL_KEYS.has(k)))
    )
  );

  return t.Object(mergedProperties, mergedOptions) as AnySchema;
}

/**
 * Applies top-level `default` values from a TypeBox TObject schema to a
 * values record. Used in the `/_furin/data` endpoint so loaders see the same
 * defaulted query objects that the SSR path produces via Elysia's guard.
 */
export function applySchemaDefaults(
  schema: UnknownObject | undefined,
  values: UnknownObject
): UnknownObject {
  if (!schema || typeof schema !== "object") {
    return values;
  }
  const s = schema;
  if (s.type !== "object" || !s.properties || typeof s.properties !== "object") {
    return values;
  }
  const result = { ...values };
  const properties = s.properties as { [key: string]: UnknownObject };
  for (const [key, propSchema] of Object.entries(properties)) {
    if (
      !(key in result) &&
      propSchema &&
      typeof propSchema === "object" &&
      "default" in propSchema
    ) {
      result[key] = propSchema.default;
    }
  }
  return result;
}
