import { readFileSync } from "node:fs";
import { parse } from "yuku-parser";
import { detectLangFromPath, unwrapTSExpression } from "../server/lang-detect.ts";
import { type AstNode, walkAST } from "../shared/utils/ast-walk.ts";

/**
 * Statically scans a server entry file and returns all `pagesDir` string
 * literal values found inside `furin({ pagesDir: "..." })` call expressions.
 *
 * Dynamic paths (template literals, variables) are silently ignored.
 * Returns an empty array when nothing is detected.
 */
export function scanFurinInstances(serverEntryPath: string): string[] {
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

  const results: string[] = [];
  walkAST(program as unknown as AstNode, (node) => {
    if (node.type === "CallExpression") {
      checkFurinCall(node, results);
    }
  });
  return results;
}

/** Checks whether `node` is a `furin({ pagesDir: "..." })` call and, if so, pushes the value. */
function checkFurinCall(node: AstNode, out: string[]): void {
  const callee = node.callee as AstNode | undefined;
  const args = node.arguments as AstNode[] | undefined;
  const isFurinCall =
    callee?.type === "Identifier" && (callee as { name?: string }).name === "furin";

  if (!(isFurinCall && Array.isArray(args)) || args.length === 0) {
    return;
  }

  // Unwrap TS expression wrappers like `furin({...} as Config)` or
  // `furin({...} satisfies Options)` so we still see the ObjectExpression.
  const firstArg = unwrapTSExpression(args[0] as AstNode);
  if (firstArg?.type !== "ObjectExpression") {
    return;
  }

  const pagesDir = extractStringProperty(firstArg, "pagesDir");
  if (pagesDir !== null) {
    out.push(pagesDir);
  }
}

function extractStringProperty(obj: AstNode, propName: string): string | null {
  const properties = obj.properties as AstNode[] | undefined;
  if (!Array.isArray(properties)) {
    return null;
  }

  for (const prop of properties) {
    if (prop.type !== "Property") {
      continue;
    }
    const key = prop.key as AstNode & { name?: string; value?: unknown };
    const value = prop.value as AstNode & { value?: unknown };

    const keyMatches =
      (key.type === "Identifier" && key.name === propName) ||
      (key.type === "Literal" && key.value === propName);

    if (!keyMatches) {
      continue;
    }

    // Only accept string literals — ignore template literals, identifiers, etc.
    if (value?.type === "Literal" && typeof value.value === "string") {
      return value.value;
    }
    return null; // dynamic path — silently skip
  }
  return null;
}
