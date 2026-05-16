import MagicString from "magic-string";
import { parse, type SourceLang } from "yuku-parser";
import { detectLangFromPath, unwrapTSExpression } from "../lang-detect";

// loader: data fetching (runs on server only)
// query / params: Elysia TypeBox schemas — validated server-side, not used in browser
const SERVER_ONLY_PROPERTIES = new Set(["loader", "query", "params", "staticParams"]);

interface TransformResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]> | null;
  removedServerCode: boolean;
}

// ---------------------------------------------------------------------------
// ESTree node types (minimal subset needed for our walk)
// ---------------------------------------------------------------------------
interface AstNode {
  body?: AstNode[];
  end: number;
  start: number;
  type: string;
  [key: string]: unknown;
}

interface Property extends AstNode {
  // Identifier key: { loader: fn }  →  key.name === "loader"
  // Literal key:    { "loader": fn } →  key.value === "loader"
  key: AstNode & { name?: string; value?: unknown };
  type: "Property";
}

interface SpreadElement extends AstNode {
  argument: AstNode;
  type: "SpreadElement";
}

interface ObjectExpression extends AstNode {
  // properties may include SpreadElement nodes, e.g. { ...spread, loader: fn }
  properties: Array<Property | SpreadElement>;
  type: "ObjectExpression";
}

interface CallExpression extends AstNode {
  arguments: AstNode[];
  callee: AstNode & { name?: string; property?: AstNode & { name?: string } };
  type: "CallExpression";
}

interface ImportDeclaration extends AstNode {
  specifiers: Array<AstNode & { local: AstNode & { name: string } }>;
  type: "ImportDeclaration";
}

// ---------------------------------------------------------------------------
// AST walking
// ---------------------------------------------------------------------------
function walk(node: unknown, visitor: (n: AstNode) => void): void {
  if (!node || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      walk(child, visitor);
    }
    return;
  }
  const n = node as AstNode;
  if (typeof n.type === "string") {
    visitor(n);
  }
  for (const key of Object.keys(n)) {
    if (key === "type" || key === "start" || key === "end") {
      continue;
    }
    walk(n[key], visitor);
  }
}

// ---------------------------------------------------------------------------
// Check if a CallExpression is createRoute() or page() / route.page()
// ---------------------------------------------------------------------------
function isCreateRouteCall(node: CallExpression): boolean {
  return node.callee.type === "Identifier" && node.callee.name === "createRoute";
}

function isRoutePageCall(node: CallExpression): boolean {
  const { callee } = node;
  if (callee.type === "Identifier" && callee.name === "page") {
    return true;
  }
  if (callee.type === "MemberExpression" && callee.property?.name === "page") {
    return true;
  }
  return false;
}

function isTargetCall(node: CallExpression): boolean {
  return isCreateRouteCall(node) || isRoutePageCall(node);
}

// ---------------------------------------------------------------------------
// Remove server-only properties from an ObjectExpression using MagicString.
// Returns true if any property was removed.
// ---------------------------------------------------------------------------
function removeServerProperties(s: MagicString, source: string, obj: ObjectExpression): boolean {
  const toRemove = obj.properties.filter((p): p is Property => {
    // Skip spread elements — they have no key.
    if (p.type !== "Property") {
      return false;
    }
    const { key } = p;
    // Static identifier key: { loader: fn }
    if (p.computed) {
      return false;
    }
    if (key.type === "Identifier" && typeof key.name === "string") {
      return SERVER_ONLY_PROPERTIES.has(key.name);
    }
    // Quoted string key: { "loader": fn }
    if (key.type === "Literal" && typeof key.value === "string") {
      return SERVER_ONLY_PROPERTIES.has(key.value);
    }
    return false;
  });
  if (toRemove.length === 0) {
    return false;
  }

  for (const prop of toRemove) {
    // Find the range to remove including the trailing comma + whitespace.
    let removeEnd = prop.end;
    // Skip comma and whitespace after the property
    while (
      removeEnd < source.length &&
      (source[removeEnd] === "," ||
        source[removeEnd] === " " ||
        source[removeEnd] === "\n" ||
        source[removeEnd] === "\r" ||
        source[removeEnd] === "\t")
    ) {
      if (source[removeEnd] === ",") {
        removeEnd++;
        break;
      }
      removeEnd++;
    }

    // Also remove leading whitespace (indentation before the property)
    let removeStart = prop.start;
    while (
      removeStart > 0 &&
      (source[removeStart - 1] === " " || source[removeStart - 1] === "\t")
    ) {
      removeStart--;
    }
    // If there's a newline before the leading whitespace, consume it too
    if (removeStart > 0 && source[removeStart - 1] === "\n") {
      removeStart--;
      if (removeStart > 0 && source[removeStart - 1] === "\r") {
        removeStart--;
      }
    }

    s.remove(removeStart, removeEnd);
  }

  return true;
}

// TypeScript-specific node types that introduce a type-only scope. Any
// Identifier / JSXIdentifier beneath one of these nodes is a TypeScript type
// reference, not a runtime value reference, and must not count toward DCE refs.
const TYPE_SCOPE_NODES = new Set([
  "TSTypeAnnotation", // `: Type` on variables, params, return types
  "TSTypeParameterDeclaration", // `<T>` in generic type-param declarations
  "TSTypeParameterInstantiation", // `<T>` in generic instantiation positions
  "TSInterfaceDeclaration", // `interface Foo { … }` — entirely type-level
  "TSTypeAliasDeclaration", // `type Foo = …` — entirely type-level
  "TSTypePredicate", // `x is Type` in return-type position
  "TSClassImplements", // `class C implements Iface` — the implements clause is type-only
]);

// Walk `node` and add every Identifier / JSXIdentifier found inside it to
// `excluded`. Called for nodes that are entirely in type position (e.g. a
// TSTypeAnnotation) so their descendant identifiers are ignored by DCE.
function markTypeDescendants(node: unknown, excluded: Set<unknown>): void {
  if (!node || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      markTypeDescendants(item, excluded);
    }
    return;
  }
  const n = node as AstNode;
  if (n.type === "Identifier" || n.type === "JSXIdentifier") {
    excluded.add(n);
  }
  for (const key of Object.keys(n)) {
    if (key === "type" || key === "start" || key === "end") {
      continue;
    }
    markTypeDescendants(n[key], excluded);
  }
}

// Excludes identifiers that appear in TypeScript type-only positions from the
// `excluded` set. Extracted from the Pass-1 walk callback to keep cognitive
// complexity within the allowed budget.
function excludeTypePositionIdentifiers(node: AstNode, excluded: Set<unknown>): void {
  if (TYPE_SCOPE_NODES.has(node.type)) {
    markTypeDescendants(node, excluded);
    return;
  }
  // TSAsExpression (`x as T`), TSSatisfiesExpression (`x satisfies T`), and
  // TSTypeAssertion (`<T>x`) are mixed: the expression child is runtime; only
  // the typeAnnotation child is type-only.
  if (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSTypeAssertion"
  ) {
    markTypeDescendants(node.typeAnnotation as unknown, excluded);
  }
}

// ---------------------------------------------------------------------------
// Collect all Identifier / JSXIdentifier names referenced in the AST
// (excluding imports). Skips identifiers in non-reference positions:
//
//   • Static (non-computed) object property keys     — `{ loader: fn }`
//   • Static (non-computed) member access properties — `obj.prop`
//   • JSX attribute names                            — `<div className=...>`
//   • Right-hand side of a JSXMemberExpression chain — `<UI.Button>` (Button)
//   • TypeScript type positions                      — `: MyType`, `<T>`, etc.
//
// Computed keys like `{ [someVar]: v }` are left in — they ARE references.
// JSX tag positions ARE references — `<Link>` requires the `Link` binding
// to be in scope, so omitting JSXIdentifier (the default after the parser
// switch from Bun.Transpiler to yuku-parser) silently drops imports that
// are only used as JSX tags.
// ---------------------------------------------------------------------------
function collectReferencedNames(program: AstNode): Set<string> {
  const refs = new Set<string>();
  // Nodes that occupy a non-reference Identifier / JSXIdentifier position.
  const excluded = new Set<unknown>();

  for (const stmt of program.body ?? []) {
    if (stmt.type === "ImportDeclaration") {
      continue;
    }
    // Pass 1 — mark non-reference identifier positions.
    // Only exclude *static* keys (computed=false); computed keys like
    // `{ [someVar]: v }` are genuine identifier references.
    walk(stmt, (node) => {
      if (node.type === "Property" && !node.computed) {
        excluded.add(node.key);
      }
      if (node.type === "MemberExpression" && !node.computed) {
        excluded.add(node.property);
      }
      // `<div className="...">` — the attribute *name* is a key, not a ref.
      if (node.type === "JSXAttribute") {
        excluded.add(node.name);
      }
      // `<UI.Button>` — `UI` is the live binding, `.Button` is a property
      // lookup on it. Exclude the property side of every JSXMemberExpression
      // so a same-named import (e.g. `import { Button } from ...`) doesn't
      // get falsely kept alive by every `<Foo.Button>` in the file.
      if (node.type === "JSXMemberExpression") {
        excluded.add(node.property);
      }
      excludeTypePositionIdentifiers(node, excluded);
    });
  }

  for (const stmt of program.body ?? []) {
    if (stmt.type === "ImportDeclaration") {
      continue;
    }
    // Pass 2 — collect genuine identifier references.
    walk(stmt, (node) => {
      if (excluded.has(node)) {
        return;
      }
      if (
        (node.type === "Identifier" || node.type === "JSXIdentifier") &&
        typeof (node as AstNode & { name: string }).name === "string"
      ) {
        refs.add((node as AstNode & { name: string }).name);
      }
    });
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Import pruning helpers
// ---------------------------------------------------------------------------
function removeEntireImport(s: MagicString, code: string, decl: ImportDeclaration): void {
  let removeEnd = decl.end;
  while (removeEnd < code.length && (code[removeEnd] === "\n" || code[removeEnd] === "\r")) {
    removeEnd++;
  }
  s.remove(decl.start, removeEnd);
}

function removeUnusedSpecifiers(
  s: MagicString,
  code: string,
  decl: ImportDeclaration,
  refs: Set<string>
): void {
  const removedSpecs = decl.specifiers.filter((spec) => !refs.has(spec.local.name));
  for (const spec of removedSpecs) {
    let removeStart = spec.start;
    let removeEnd = spec.end;
    while (removeEnd < code.length && (code[removeEnd] === "," || code[removeEnd] === " ")) {
      removeEnd++;
    }
    if (!code.slice(spec.end, removeEnd).includes(",")) {
      while (removeStart > 0 && (code[removeStart - 1] === " " || code[removeStart - 1] === ",")) {
        removeStart--;
      }
    }
    s.remove(removeStart, removeEnd);
  }
}

// ---------------------------------------------------------------------------
// Dead code elimination: remove import specifiers that are no longer
// referenced after server property removal.
//
// A fresh MagicString is created from s.toString() so that the AST offsets
// produced by re-parsing the *current* output agree with the string positions
// operated on by MagicString.remove() — the original MagicString always uses
// original-source positions, which diverge from output positions whenever
// earlier passes have removed content.
// ---------------------------------------------------------------------------
export function deadCodeElimination(s: MagicString, lang: SourceLang): MagicString {
  const code = s.toString();
  const { program, diagnostics } = parse(code, { sourceType: "module", lang });
  const firstError = diagnostics.find((d) => d.severity === "error");
  if (firstError) {
    console.error("[furin] DCE: failed to parse transformed output:", firstError.message);
    return s;
  }

  const fresh = new MagicString(code);
  const programNode = program as unknown as AstNode;
  const refs = collectReferencedNames(programNode);

  const body = programNode.body ?? [];
  for (let i = body.length - 1; i >= 0; i--) {
    const stmt = body[i];
    if (!stmt) {
      continue;
    }
    if (stmt.type !== "ImportDeclaration") {
      continue;
    }
    const decl = stmt as unknown as ImportDeclaration;
    if (!decl.specifiers || decl.specifiers.length === 0) {
      continue;
    }

    const usedCount = decl.specifiers.filter((spec) => refs.has(spec.local.name)).length;

    if (usedCount === 0) {
      removeEntireImport(fresh, code, decl);
    } else if (usedCount < decl.specifiers.length) {
      removeUnusedSpecifiers(fresh, code, decl, refs);
    }
  }

  return fresh;
}

// ---------------------------------------------------------------------------
// Remove server-only properties from createRoute() / page() / route.page()
// calls found anywhere in the AST.
// ---------------------------------------------------------------------------
function removeServerExports(s: MagicString, source: string, program: AstNode): boolean {
  let removedServerCode = false;

  walk(program, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const call = node as CallExpression;
    if (!isTargetCall(call)) {
      return;
    }
    // Unwrap `createRoute({...} as Config)` / `page({...} satisfies Opts)` etc.
    const arg = call.arguments[0] ? unwrapTSExpression(call.arguments[0]) : undefined;
    if (!arg || arg.type !== "ObjectExpression") {
      return;
    }
    if (removeServerProperties(s, source, arg as ObjectExpression)) {
      removedServerCode = true;
    }
  });

  return removedServerCode;
}

export function transformForClient(code: string, filename: string): TransformResult {
  // .d.ts files have no runtime code — yuku rejects parsing them as modules.
  // Treat as a passthrough so callers don't need to pre-filter.
  const lang = detectLangFromPath(filename);
  if (lang === "dts") {
    return { code, map: null, removedServerCode: false };
  }

  // Pass 1 — yuku-parser: parse TS/TSX/JS/JSX directly to ESTree AST with
  // span offsets calibrated against `code` itself (no transpile step).
  const { program, diagnostics } = parse(code, { sourceType: "module", lang });
  const firstError = diagnostics.find((d) => d.severity === "error");
  if (firstError) {
    throw new Error(`Failed to parse ${filename}: ${firstError.message}`);
  }

  // Pass 2 — MagicString: surgically remove server-only properties.
  let s = new MagicString(code);
  const removedServerCode = removeServerExports(s, code, program as unknown as AstNode);

  // Pass 3 — DCE: prune imports that are no longer referenced.
  // deadCodeElimination returns a fresh MagicString keyed on the current
  // output so its internal AST offsets remain consistent.
  if (removedServerCode) {
    s = deadCodeElimination(s, lang);
  }

  return {
    code: s.toString(),
    map: s.generateMap({ source: filename, includeContent: true }),
    removedServerCode,
  };
}
