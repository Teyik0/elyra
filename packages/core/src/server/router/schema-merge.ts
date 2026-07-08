import { t } from "elysia";
import type { AnySchema } from "elysia/types";
import type { RuntimeRoute } from "../../client.ts";

interface SchemaObject {
  [key: string]: unknown;
}

const TOBJECT_STRUCTURAL_KEYS = new Set(["type", "properties", "required"]);
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

function isTypeBoxObjectSchema(schema: unknown): schema is SchemaObject {
  return (
    schema !== null &&
    typeof schema === "object" &&
    (schema as SchemaObject & { [key: symbol]: unknown })[TYPEBOX_KIND] === "Object"
  );
}

export function mergeRouteSchemas(
  routeChain: RuntimeRoute[],
  key: "params" | "query"
): AnySchema | undefined {
  const schemas = routeChain.flatMap((route) => (route[key] ? [route[key] as SchemaObject] : []));

  if (schemas.length === 0) {
    return;
  }
  if (schemas.length === 1) {
    return schemas[0] as AnySchema;
  }
  if (schemas.some((schema) => !isTypeBoxObjectSchema(schema))) {
    throw new Error(
      `[furin] Merging ${key} schemas across the route chain requires TypeBox in V1. Use TypeBox for parent/child ${key}, or define ${key} only on leaf routes.`
    );
  }

  const properties = Object.assign(
    {},
    ...schemas.map((schema) => (schema.properties as SchemaObject) ?? {})
  );
  const options = Object.assign(
    {},
    ...schemas.map((schema) =>
      Object.fromEntries(
        Object.entries(schema).filter(([name]) => !TOBJECT_STRUCTURAL_KEYS.has(name))
      )
    )
  );

  return t.Object(properties, options) as AnySchema;
}
