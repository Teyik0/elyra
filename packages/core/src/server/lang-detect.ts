import type { SourceLang } from "yuku-parser";

export function detectLangFromPath(filePath: string): SourceLang {
  if (filePath.endsWith(".d.ts")) {
    return "dts";
  }
  if (filePath.endsWith(".tsx")) {
    return "tsx";
  }
  if (filePath.endsWith(".ts")) {
    return "ts";
  }
  if (filePath.endsWith(".jsx")) {
    return "jsx";
  }
  return "js";
}

interface MaybeWrappedNode {
  expression?: unknown;
  type: string;
}

const TS_WRAPPER_TYPES = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "TSNonNullExpression",
  "TSInstantiationExpression",
  "ParenthesizedExpression",
]);

export function unwrapTSExpression<T extends { type: string }>(node: T): T {
  let current: MaybeWrappedNode = node;
  while (
    current &&
    typeof current === "object" &&
    TS_WRAPPER_TYPES.has(current.type) &&
    current.expression &&
    typeof current.expression === "object"
  ) {
    current = current.expression as MaybeWrappedNode;
  }
  return current as T;
}
