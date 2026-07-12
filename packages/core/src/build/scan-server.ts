import { readFileSync } from "node:fs";
import { parse, type CallExpression, type ObjectExpression, type ObjectProperty } from "yuku-parser";
import { normalizePrefix } from "../server/instance.ts";
import { detectLangFromPath, unwrapTSExpression } from "../server/lang-detect.ts";
import { walkAST } from "../shared/utils/ast-walk.ts";

export interface ScannedFurinInstance {
  pagesDir: string;
  /** Normalized mount prefix (`""` when absent). */
  prefix: string;
}

/**
 * Statically scans a server entry file and returns the `pagesDir` (and
 * optional `prefix`) string literals found inside `furin({ pagesDir: "..." })`
 * call expressions.
 *
 * Dynamic values (template literals, variables) are silently ignored.
 * Returns an empty array when nothing is detected.
 */
export function scanFurinInstances(serverEntryPath: string): ScannedFurinInstance[] {
  const code = readFileSync(serverEntryPath, "utf8");
  const lang = detectLangFromPath(serverEntryPath);

  // Declaration files contain no runtime code — skip parsing.
  if (lang === "dts") {
    return [];
  }

  const { program, diagnostics } = parse(code, { sourceType: "module", lang });
  const firstError = diagnostics.find((d) => d.severity === "error");
  if (firstError) {
    console.error("[furin] scan-server: parse error:", firstError.message, "in", serverEntryPath);
    return [];
  }

  const results: ScannedFurinInstance[] = [];
  walkAST(program, (node) => {
    if (node.type === "CallExpression") {
      checkFurinCall(node as unknown as CallExpression, results);
    }
  });
  return results;
}

/** Checks whether `node` is a `furin({ pagesDir: "..." })` call and, if so, pushes the value. */
function checkFurinCall(node: CallExpression, out: ScannedFurinInstance[]): void {
  const isFurinCall = node.callee.type === "Identifier" && node.callee.name === "furin";

  if (!isFurinCall || node.arguments.length === 0) {
    return;
  }

  // Unwrap TS expression wrappers like `furin({...} as Config)` or
  // `furin({...} satisfies Options)` so we still see the ObjectExpression.
  const firstArgNode = node.arguments[0];
  if (!firstArgNode) {
    return;
  }
  const firstArg = unwrapTSExpression(firstArgNode);
  if (!isObjectExpressionNode(firstArg)) {
    return;
  }

  const pagesDir = extractStringProperty(firstArg, "pagesDir");
  if (pagesDir !== null) {
    const prefix = extractStringProperty(firstArg, "prefix");
    out.push({ pagesDir, prefix: normalizeScannedPrefix(prefix) });
  }
}

// Delegates to the runtime's normalizePrefix so a literal that would make
// `furin()` throw at startup fails at build time too, with the same message —
// silently "fixing" it here would build assets the runtime never serves.
function normalizeScannedPrefix(prefix: string | null): string {
  return normalizePrefix(prefix ?? undefined);
}

function isObjectExpressionNode(node: { type: string }): node is ObjectExpression {
  return node.type === "ObjectExpression";
}

function extractStringProperty(obj: ObjectExpression, propName: string): string | null {
  for (const prop of obj.properties) {
    if (prop.type !== "Property") {
      continue;
    }
    const value = getStringPropertyValue(prop, propName);

    if (value !== undefined) {
      return value;
    }
  }
  return null;
}

function getStringPropertyValue(prop: ObjectProperty, propName: string): string | null | undefined {
  const keyMatches =
    (prop.key.type === "Identifier" && prop.key.name === propName) ||
    (prop.key.type === "Literal" && prop.key.value === propName);

  if (!keyMatches) {
    return undefined;
  }

  // Only accept string literals — ignore template literals, identifiers, etc.
  if (prop.value.type === "Literal" && typeof prop.value.value === "string") {
    return prop.value.value;
  }
  return null; // dynamic path — silently skip
}
