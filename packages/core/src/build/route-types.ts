import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSchemaProperties } from "elysia/schema";
import type { RuntimeRoute } from "../client.ts";
import { type ResolvedRoute } from "../server/router/index.ts";

/** @internal Exported for unit testing only. */
export function patternToTypeString(pattern: string): string {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional — generates TS template literal syntax
  const t = pattern.replace(/:[^/]+/g, "${string}").replace(/\*/g, "${string}");
  return t.includes("${") ? `\`${t}\`` : `"${t}"`;
}

/**
 * Converts a runtime TypeBox/JSON Schema object to a TypeScript type string.
 * Handles the common cases found in Elysia query schemas (string, number, boolean,
 * optional fields, nullable via anyOf).
 *
 * @internal Exported for unit testing only.
 */
export function schemaToTypeString(schema: unknown): string {
  return schemaToTypeStringWithDefaults(schema, true);
}

function schemaToTypeStringWithDefaults(schema: unknown, defaultsAreRequired: boolean): string {
  if (!schema || typeof schema !== "object") {
    return "unknown";
  }
  const s = schema as Record<string, unknown>;
  if (s.anyOf && Array.isArray(s.anyOf)) {
    const parts: string[] = [];
    for (const item of s.anyOf as unknown[]) {
      const t = schemaToTypeStringWithDefaults(item, defaultsAreRequired);
      if (t !== "null") parts.push(t);
    }
    return parts.join(" | ") || "unknown";
  }
  switch (s.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const inner = schemaToTypeStringWithDefaults(s.items, defaultsAreRequired);
      return inner.includes("|") || inner.includes("&") ? `(${inner})[]` : `${inner}[]`;
    }
    case "object": {
      if (!s.properties || typeof s.properties !== "object") {
        return "Record<string, unknown>";
      }
      const required = new Set<string>(Array.isArray(s.required) ? (s.required as string[]) : []);
      const props = Object.entries(s.properties as Record<string, unknown>)
        .map(([k, v]) => {
          const isPresent =
            required.has(k) || (defaultsAreRequired && hasNonNullSchemaDefault(v));
          return `${k}${isPresent ? "" : "?"}: ${schemaToTypeStringWithDefaults(v, defaultsAreRequired)}`;
        })
        .join("; ");
      return `{ ${props} }`;
    }
    default:
      return "unknown";
  }
}

/** @internal Exported for unit testing only. */
export function schemaToInputTypeString(schema: unknown): string {
  return schemaToTypeStringWithDefaults(schema, false);
}

function hasNonNullSchemaDefault(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") {
    return false;
  }
  const s = schema as Record<string, unknown>;
  return (
    "default" in s &&
    s.default != null
  );
}

function tagKeyToPropertyName(tag: string): string {
  return /^[$A-Z_a-z][$\w]*$/.test(tag) ? tag : JSON.stringify(tag);
}

function tagToStringLiteral(tag: string): string {
  // Use JSON.stringify for robust escaping of control chars, unicode
  // separators, backslashes and quotes, then convert double quotes to single.
  const json = JSON.stringify(tag);
  // json is double-quoted; convert to single-quoted literal by escaping
  // any contained single quotes and swapping the outer quotes.
  return `'${json.slice(1, -1).replaceAll("'", "\\'")}'`;
}

interface StandardJSONSchemaResult {
  properties: Record<string, unknown>;
  required: string[];
}

function getStandardJSONSchemaProperties(schema: unknown): StandardJSONSchemaResult | undefined {
  try {
    const standard = (schema as Record<string, unknown>)["~standard"] as
      | Record<string, unknown>
      | undefined;
    if (!standard || typeof standard !== "object" || !("jsonSchema" in standard)) {
      return undefined;
    }
    const jsonSchema = (standard["jsonSchema"] as Record<string, unknown>)["input"] as (
      opts: unknown,
    ) => unknown;
    const result = jsonSchema({ target: "draft-2020-12" }) as Record<string, unknown>;
    if (result.type === "object" && result.properties && typeof result.properties === "object") {
      return {
        properties: result.properties as Record<string, unknown>,
        required: Array.isArray(result.required) ? (result.required as string[]) : [],
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** @internal Exported for unit testing only. */
export function mergeRouteSchemas(
  routeChain: RuntimeRoute[],
  key: "query" | "params"
): unknown {
  const allProperties: Record<string, unknown> = {};
  const allRequired = new Set<string>();
  let hasAny = false;

  for (const routeNode of routeChain) {
    const schema = routeNode[key];
    if (!schema) continue;
    hasAny = true;

    const typeboxProps = getSchemaProperties(schema as any);
    if (typeboxProps) {
      Object.assign(allProperties, typeboxProps);
    } else {
      const standardProps = getStandardJSONSchemaProperties(schema);
      if (standardProps) {
        Object.assign(allProperties, standardProps.properties);
        for (const r of standardProps.required) {
          allRequired.add(r);
        }
      } else {
        return { type: "unknown" };
      }
    }
  }

  if (!hasAny) return undefined;
  if (Object.keys(allProperties).length === 0) return undefined;
  return { type: "object", properties: allProperties, required: [...allRequired] };
}

/**
 * Generates furin-env.d.ts at the project root — augments RouteManifest
 * in furin/link so that <Link to="..."> has type-safe autocompletion and
 * <Link search={...}> is typed per-route from the route's query schema.
 *
 * Written to the project root (like Next.js's next-env.d.ts) so it is
 * committed to git and always available in CI without a build step.
 */
/** @internal Exported for unit testing only. */
export function writeRouteTypes(routes: ResolvedRoute[], projectRoot: string): void {
  const sortedRoutes = routes.toSorted((a, b) => a.pattern.localeCompare(b.pattern));
  const entries = sortedRoutes.map((r) => {
    const typeKey = patternToTypeString(r.pattern);
    const isDynamic = typeKey.startsWith("`");
    const querySchema = mergeRouteSchemas(r.routeChain ?? [], "query");
    const searchType = querySchema ? schemaToTypeString(querySchema) : "never";
    const searchInputType = querySchema ? schemaToInputTypeString(querySchema) : "never";
    return isDynamic
      ? `    [key: ${typeKey}]: { search?: ${searchType}; searchInput?: ${searchInputType} }`
      : `    ${typeKey}: { search?: ${searchType}; searchInput?: ${searchInputType} }`;
  });
  const routeManifestEntries = entries.join(";\n");

  const sortedTags = [...new Set(routes.flatMap((route) => route.tags ?? []))].toSorted();
  const tagBlock =
    sortedTags.length > 0
      ? `\n\ndeclare module "@teyik0/furin" {\n  interface FurinCacheTags {\n${sortedTags
          .map((tag) => `    ${tagKeyToPropertyName(tag)}: ${tagToStringLiteral(tag)};`)
          .join("\n")}\n  }\n}`
      : "";

  const content = `// Auto-generated by Furin. Do not edit manually.
/// <reference types="@teyik0/furin/env" />
import "@teyik0/furin/link";

declare module "@teyik0/furin/link" {
  interface RouteManifest {
${routeManifestEntries};
  }
}${tagBlock}
`;

  const typesPath = join(projectRoot, "furin-env.d.ts");
  const existing = existsSync(typesPath) ? readFileSync(typesPath, "utf8") : "";
  if (content !== existing) {
    writeFileSync(typesPath, content);
  }
}
