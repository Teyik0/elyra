import type { Context } from "elysia";
import { t } from "elysia";
import type { AnySchema } from "elysia/types";
import type { RuntimeRoute } from "../../client.ts";

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
