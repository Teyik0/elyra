import { t } from "elysia";
import { parseQueryFromURL, parseQueryStandardSchema } from "elysia/parse-query";
import { getSchemaValidator } from "elysia/schema";
import type { AnySchema } from "elysia/types";
import type { RuntimeRoute } from "../../client.ts";
import {
  collectSearchDefaults,
  type SearchParamsInput,
  type SearchRouteMetadata,
} from "../../shared/search-params.ts";
import { buildRouteRegex } from "./patterns.ts";

interface UnknownObject {
  [key: string]: unknown;
}

interface QueryKeyMap {
  [key: string]: 1;
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
    const effectiveSchema = findEffectiveAnyOfMember(value, "array") ?? value;
    if (isObjectSchema(effectiveSchema) && effectiveSchema.type === "array") {
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
    const effectiveSchema = findEffectiveAnyOfMember(value, "object") ?? value;
    if (isObjectSchema(effectiveSchema) && effectiveSchema.type === "object") {
      keys[key] = 1;
    }
  }

  return Object.keys(keys).length > 0 ? keys : undefined;
}

function findEffectiveAnyOfMember(
  schema: unknown,
  type: "array" | "object"
): UnknownObject | undefined {
  if (!(isObjectSchema(schema) && Array.isArray(schema.anyOf))) {
    return;
  }

  for (const member of schema.anyOf) {
    if (isObjectSchema(member) && member.type === type) {
      return member;
    }
  }
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
  | { ok: true; query: SearchParamsInput }
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
    return { ok: true, query: parseQueryFromURL(url.search, 1) as SearchParamsInput };
  }

  if (isStandardSchema(schema)) {
    const rawQuery = parseQueryStandardSchema(url.search, 1) as UnknownObject;
    const validator = getSchemaValidator(schema, { dynamic: true });
    const checked = await validator?.Check(rawQuery);
    if (checked && typeof checked === "object" && "issues" in checked) {
      return { errors: checked.issues, ok: false };
    }
    if (checked && typeof checked === "object" && "value" in checked) {
      return { ok: true, query: checked.value as SearchParamsInput };
    }
    return { ok: true, query: rawQuery as SearchParamsInput };
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
    query: (validator?.parse(queryWithDefaults) ?? queryWithDefaults) as SearchParamsInput,
  };
}

// Standard structural keys on a TObject — everything else is a user-supplied option
// (e.g. additionalProperties, $id, description, title) and must be preserved.
const TOBJECT_STRUCTURAL_KEYS = new Set(["type", "properties", "required"]);
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

function isTypeBoxObjectSchema(schema: unknown): schema is UnknownObject {
  return (
    isObjectSchema(schema) &&
    (schema as UnknownObject & { [key: symbol]: unknown })[TYPEBOX_KIND] === "Object"
  );
}

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

  if (schemas.some((s) => !isTypeBoxObjectSchema(s))) {
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

export function createSearchRouteMetadata(
  routes: Array<{ pattern: string; routeChain: RuntimeRoute[] }>
): SearchRouteMetadata[] {
  const metadata: SearchRouteMetadata[] = [];
  for (const route of routes) {
    const searchDefaults = collectSearchDefaults(mergeRouteSchemas(route.routeChain, "query"));
    if (!searchDefaults) {
      continue;
    }
    metadata.push({
      pattern: route.pattern,
      regex: buildRouteRegex(route.pattern).regex,
      searchDefaults,
    });
  }
  return metadata;
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
