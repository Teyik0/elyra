import type { Context } from "elysia";
import { t } from "elysia";
import type { AnySchema } from "elysia/types";
import type { RuntimeRoute } from "../../client.ts";

export interface SchemaSource {
  __type?: unknown;
  params?: unknown;
  query?: unknown;
}

interface JsonSchemaObject {
  properties?: JsonSchemaProperties;
  required?: string[];
  type: "object";
  [key: string]: unknown;
}

interface JsonSchemaProperty {
  anyOf?: JsonSchemaProperty[];
  items?: JsonSchemaProperty;
  oneOf?: JsonSchemaProperty[];
  properties?: JsonSchemaProperties;
  required?: string[];
  type?: string;
  [key: string]: unknown;
}

interface JsonSchemaProperties {
  [key: string]: JsonSchemaProperty;
}

// ── JSON Schema conversion ──────────────────────────────────────────────────

/** Converts any supported schema (TypeBox, Zod 4, Valibot via toStandardJsonSchema,
 *  or a plain JSON Schema object) into a JSON Schema record.
 *  Throws a clear error for unsupported schemas (e.g. plain objects, Zod 3). */
function toJSONSchema(schema: unknown, key: "params" | "query"): JsonSchemaObject {
  if (!schema || typeof schema !== "object") {
    throw new Error(
      `[furin] Unsupported ${key} schema. Schema must be a TypeBox object, ` +
        "a Zod 4 schema (z.object()), a Valibot schema wrapped with toStandardJsonSchema(), " +
        `or a plain JSON Schema object. Received: ${typeof schema}`
    );
  }

  const s = schema as Record<string, unknown>;

  // Plain JSON Schema / TypeBox (already has type+properties, no ~standard)
  if (s.type === "object" && s.properties && !s["~standard"]) {
    return s as unknown as JsonSchemaObject;
  }

  // StandardJSONSchemaV1 — Zod 4, Valibot via toStandardJsonSchema, etc.
  const standard = s["~standard"] as Record<string, unknown> | undefined;
  if (standard && typeof standard.jsonSchema === "object") {
    const converter = standard.jsonSchema as Record<string, unknown>;
    if (typeof converter.output === "function") {
      return ensureJsonSchemaObject(converter.output({ target: "draft-2020-12" }), key);
    }
  }

  // Zod 4 instance method (fallback when ~standard.jsonSchema is missing)
  if (typeof (s as { toJSONSchema?: () => unknown }).toJSONSchema === "function") {
    return ensureJsonSchemaObject((s as { toJSONSchema: () => unknown }).toJSONSchema(), key);
  }

  throw new Error(
    `[furin] Unsupported ${key} schema. Schema must be a TypeBox object, ` +
      "a Zod 4 schema (z.object()), a Valibot schema wrapped with toStandardJsonSchema(), " +
      "or a plain JSON Schema object. " +
      "If you are using Valibot, wrap your schema with toStandardJsonSchema() from @valibot/to-json-schema."
  );
}

function ensureJsonSchemaObject(schema: unknown, key: "params" | "query"): JsonSchemaObject {
  if (!schema || typeof schema !== "object") {
    throw new Error(`[furin] ${key} schemas must be objects. Received: ${typeof schema}`);
  }
  const jsonSchema = schema as Partial<JsonSchemaObject>;
  if (jsonSchema.type !== "object" || !jsonSchema.properties) {
    throw new Error(`[furin] ${key} schemas must be objects.`);
  }
  return jsonSchema as JsonSchemaObject;
}

/** Strips JSON Schema fields that TypeBox does not recognise (e.g. $schema) so
 *  that t.Object() can compile the schema without a preflight validation error. */
function cleanJSONSchemaForTypeBox(schema: JsonSchemaObject): JsonSchemaObject {
  const { $schema, $defs, ...rest } = schema;
  return rest as JsonSchemaObject;
}

/** Recursively converts a JSON Schema property into a TypeBox TSchema.
 *  Handles the common types found in query schemas (string, number, boolean,
 *  null, unions via anyOf/oneOf, arrays, nested objects). */
function jsonSchemaPropertyToTypeBox(prop: JsonSchemaProperty): unknown {
  if (prop.anyOf && Array.isArray(prop.anyOf)) {
    const variants = prop.anyOf.map(jsonSchemaPropertyToTypeBox);
    // biome-ignore lint/suspicious/noExplicitAny: TypeBox internal API
    return (t as any).Union(variants, prop);
  }

  if (prop.oneOf && Array.isArray(prop.oneOf)) {
    const variants = prop.oneOf.map(jsonSchemaPropertyToTypeBox);
    // biome-ignore lint/suspicious/noExplicitAny: TypeBox internal API
    return (t as any).Union(variants, prop);
  }

  switch (prop.type) {
    case "string":
      // biome-ignore lint/suspicious/noExplicitAny: TypeBox internal API
      return t.String(prop as any);
    case "number":
    case "integer":
      // biome-ignore lint/suspicious/noExplicitAny: TypeBox internal API
      return t.Number(prop as any);
    case "boolean":
      // biome-ignore lint/suspicious/noExplicitAny: TypeBox internal API
      return t.Boolean(prop as any);
    case "null":
      // biome-ignore lint/suspicious/noExplicitAny: TypeBox internal API
      return t.Null(prop as any);
    case "array":
      return t.Array(
        // biome-ignore lint/suspicious/noExplicitAny: TypeBox internal API
        jsonSchemaPropertyToTypeBox(prop.items ?? {}) as any,
        // biome-ignore lint/suspicious/noExplicitAny: TypeBox internal API
        prop as any
      );
    case "object":
      return jsonSchemaToTypeBox(prop as JsonSchemaObject);
    default:
      // biome-ignore lint/suspicious/noExplicitAny: TypeBox internal API
      return t.Any(prop as any);
  }
}

/** Converts a JSON Schema object into a TypeBox TObject, preserving
 *  optionality via t.Optional and all object-level options. */
function jsonSchemaToTypeBox(schema: JsonSchemaObject): ReturnType<typeof t.Object> {
  const properties = schema.properties;
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);

  // biome-ignore lint/suspicious/noExplicitAny: TypeBox internal API
  const typeBoxProperties: Record<string, any> = {};
  if (properties) {
    for (const [key, prop] of Object.entries(properties)) {
      // biome-ignore lint/suspicious/noExplicitAny: TypeBox internal API
      let typeBoxProp = jsonSchemaPropertyToTypeBox(prop) as any;
      if (!required.has(key)) {
        typeBoxProp = t.Optional(typeBoxProp);
      }
      typeBoxProperties[key] = typeBoxProp;
    }
  }

  const options = Object.fromEntries(
    Object.entries(schema).filter(([k]) => !TOBJECT_STRUCTURAL_KEYS.has(k))
  );

  return t.Object(typeBoxProperties, options) as ReturnType<typeof t.Object>;
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
  resolvedQuery: Record<string, unknown>
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
    if (v != null) {
      url.searchParams.set(k, String(v));
    }
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

/** @internal Exported for unit testing. */
export function queryDefaultRedirectHook({ request, query, status, set }: Context) {
  const location = detectQueryDefaultRedirect(request, query as Record<string, unknown>);
  if (!location) {
    return;
  }
  set.headers.location = location;
  return status("Found");
}

// Standard structural keys on a JSON Schema object — everything else is a user-supplied
// option (e.g. additionalProperties, $id, description, title) and must be preserved.
const TOBJECT_STRUCTURAL_KEYS = new Set(["type", "properties", "required"]);

export function collectRouteSchemaSources(route: {
  page?: SchemaSource;
  routeChain: readonly SchemaSource[];
}): SchemaSource[] {
  const sources = [...route.routeChain];
  if (route.page?.query) {
    sources.push({ query: route.page.query });
  }
  return sources;
}

/**
 * Merges schemas from all routeChain entries for a given key.
 * Supports TypeBox, Zod 4, Valibot (via toStandardJsonSchema), and plain JSON Schema.
 * Each schema is converted to JSON Schema, then properties are spread left-to-right
 * (leaf wins on key conflict). Object-level options are also merged with leaf-wins
 * semantics so they are not silently dropped.
 * Returns undefined when no entry in the chain defines the key.
 *
 * @internal Exported for unit testing.
 */
export function mergeRouteSchemaJson(
  sources: readonly SchemaSource[],
  key: "params" | "query"
): JsonSchemaObject | undefined {
  const rawSchemas = sources.flatMap((r) => (r[key] ? [r[key]] : []));

  if (rawSchemas.length === 0) {
    return;
  }

  const jsonSchemas = rawSchemas.map((schema) =>
    cleanJSONSchemaForTypeBox(toJSONSchema(schema, key))
  );

  const mergedProperties = Object.assign({}, ...jsonSchemas.map((s) => s.properties ?? {}));

  const mergedOptions = Object.assign(
    {},
    ...jsonSchemas.map((s) =>
      Object.fromEntries(Object.entries(s).filter(([k]) => !TOBJECT_STRUCTURAL_KEYS.has(k)))
    )
  );

  return {
    type: "object",
    properties: mergedProperties,
    ...mergedOptions,
  };
}

export function mergeRouteSchemas(
  sources: readonly SchemaSource[] | RuntimeRoute[],
  key: "params" | "query"
): AnySchema | undefined {
  const rawSchemas = sources.flatMap((r) => (r[key] ? [r[key]] : []));

  if (rawSchemas.length === 0) {
    return;
  }

  // Single TypeBox / plain JSON schema — pass through as-is for identity preservation.
  if (rawSchemas.length === 1) {
    const s = rawSchemas[0] as Record<string, unknown>;
    if (s.type === "object" && s.properties && !s["~standard"]) {
      return s as AnySchema;
    }
  }

  const jsonSchema = mergeRouteSchemaJson(sources, key);
  return jsonSchema ? (jsonSchemaToTypeBox(jsonSchema) as AnySchema) : undefined;
}

/**
 * Applies top-level `default` values from a TypeBox TObject schema to a
 * values record. Used in the `/_furin/data` endpoint so loaders see the same
 * defaulted query objects that the SSR path produces via Elysia's guard.
 */
export function applySchemaDefaults(
  schema: Record<string, unknown> | undefined,
  values: Record<string, unknown>
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return values;
  }
  const s = schema as Record<string, unknown>;
  if (s.type !== "object" || !s.properties || typeof s.properties !== "object") {
    return values;
  }
  const result = { ...values };
  const properties = s.properties as Record<string, Record<string, unknown>>;
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
