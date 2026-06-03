/**
 * Minimal ESTree node interface used by AST-walking utilities across the
 * framework (build scanning, client transform, etc.).
 */
export interface AstNode {
  body?: AstNode[];
  end: number;
  start: number;
  type: string;
  [key: string]: unknown;
}

const SKIP_KEYS = new Set(["type", "start", "end"]);

/**
 * Walks an ESTree-compatible AST node recursively, calling `visitor` for every
 * node that has a `type` property.
 *
 * Arrays are traversed element-by-element.  The keys `type`, `start` and `end`
 * are skipped so that the visitor is only invoked on genuine child nodes.
 */
export function walkAST(node: unknown, visitor: (n: AstNode) => void): void {
  if (!node || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      walkAST(child, visitor);
    }
    return;
  }
  const n = node as AstNode;
  if (typeof n.type === "string") {
    visitor(n);
  }
  for (const key of Object.keys(n)) {
    if (SKIP_KEYS.has(key)) {
      continue;
    }
    walkAST(n[key], visitor);
  }
}
