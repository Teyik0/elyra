import MagicString from "magic-string";
import type {
  CallExpression,
  ImportDeclaration,
  ObjectExpression,
  ObjectProperty,
  Program,
  SourceLang,
} from "yuku-parser";
import { walk } from "yuku-parser";
import { detectLangFromPath, unwrapTSExpression } from "../server/lang-detect.ts";
import { parseSource } from "../shared/parser.ts";
import { type AstNode, walkAST } from "../shared/utils/ast-walk.ts";

// loader: data fetching (runs on server only)
// query / params: Elysia TypeBox schemas — validated server-side, not used in browser
const SERVER_ONLY_PROPERTIES = new Set([
  "loader",
  "requestLoader",
  "query",
  "params",
  "staticParams",
]);
const FURIN_CLIENT_MODULES = new Set(["@teyik0/furin/client", "furin/client"]);

interface TransformResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]> | null;
  removedServerCode: boolean;
}

interface RouteTransformBindings {
  createRouteNames: Set<string>;
  routeNames: Set<string>;
}

// ---------------------------------------------------------------------------
// Check if a CallExpression is createRoute() or route.page()
// ---------------------------------------------------------------------------
function isFurinClientModule(source: unknown): boolean {
  return typeof source === "string" && FURIN_CLIENT_MODULES.has(source);
}

function isRelativeModule(source: unknown): boolean {
  return typeof source === "string" && source.startsWith(".");
}

function importedName(spec: AstNode): string | null {
  const { imported } = spec;
  if (!imported || typeof imported !== "object") {
    return null;
  }
  const node = imported as AstNode;
  if (node.type === "Identifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return null;
}

function localName(spec: AstNode): string | null {
  const { local } = spec;
  if (!local || typeof local !== "object") {
    return null;
  }
  const node = local as AstNode;
  return node.type === "Identifier" && typeof node.name === "string" ? node.name : null;
}

function addImportedBinding(
  source: unknown,
  spec: AstNode,
  bindings: RouteTransformBindings
): void {
  if (spec.type !== "ImportSpecifier" || spec.importKind === "type") {
    return;
  }
  const imported = importedName(spec);
  const local = localName(spec);
  if (!local) {
    return;
  }
  if (isFurinClientModule(source) && imported === "createRoute") {
    bindings.createRouteNames.add(local);
  }
  if (isRelativeModule(source) && imported === "route") {
    bindings.routeNames.add(local);
  }
}

function collectImportedBindings(program: Program): RouteTransformBindings {
  const bindings = {
    createRouteNames: new Set<string>(),
    routeNames: new Set<string>(),
  };

  for (const stmt of program.body) {
    if (stmt.type !== "ImportDeclaration") {
      continue;
    }
    const decl = stmt as unknown as ImportDeclaration;
    if (decl.importKind === "type") {
      continue;
    }
    const source = decl.source.value;

    for (const spec of decl.specifiers as unknown as AstNode[]) {
      addImportedBinding(source, spec, bindings);
    }
  }

  return bindings;
}

function bindingPatternHasName(pattern: unknown, name: string): boolean {
  if (!(pattern && typeof pattern === "object")) {
    return false;
  }
  const node = pattern as AstNode;
  if (node.type === "Identifier") {
    return node.name === name;
  }
  if (node.type === "AssignmentPattern") {
    return bindingPatternHasName(node.left, name);
  }
  if (node.type === "RestElement") {
    return bindingPatternHasName(node.argument, name);
  }
  if (node.type === "ArrayPattern") {
    return (
      Array.isArray(node.elements) &&
      node.elements.some((element) => bindingPatternHasName(element, name))
    );
  }
  if (node.type === "ObjectPattern") {
    return (
      Array.isArray(node.properties) &&
      node.properties.some((property) => {
        if (!(property && typeof property === "object")) {
          return false;
        }
        const propertyNode = property as AstNode;
        return bindingPatternHasName(
          propertyNode.type === "Property" ? propertyNode.value : propertyNode.argument,
          name
        );
      })
    );
  }
  if (node.type === "TSParameterProperty") {
    return bindingPatternHasName(node.parameter, name);
  }
  return false;
}

function declarationHasName(node: AstNode, name: string): boolean {
  if (node.type === "VariableDeclaration" && Array.isArray(node.declarations)) {
    return node.declarations.some((declaration) => {
      if (!(declaration && typeof declaration === "object")) {
        return false;
      }
      return bindingPatternHasName((declaration as AstNode).id, name);
    });
  }
  if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
    return bindingPatternHasName(node.id, name);
  }
  return false;
}

function functionBodyHasVarName(value: unknown, name: string, root = true): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => functionBodyHasVarName(entry, name, false));
  }
  const node = value as AstNode;
  if (
    !root &&
    (node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression")
  ) {
    return false;
  }
  if (
    node.type === "VariableDeclaration" &&
    node.kind === "var" &&
    Array.isArray(node.declarations) &&
    node.declarations.some((declaration) =>
      declaration && typeof declaration === "object"
        ? bindingPatternHasName((declaration as AstNode).id, name)
        : false
    )
  ) {
    return true;
  }
  return Object.values(node).some((entry) => functionBodyHasVarName(entry, name, false));
}

function functionScopeHasName(scope: AstNode, name: string): boolean {
  if (
    scope.type !== "FunctionDeclaration" &&
    scope.type !== "FunctionExpression" &&
    scope.type !== "ArrowFunctionExpression"
  ) {
    return false;
  }
  return (
    (Array.isArray(scope.params) &&
      scope.params.some((param) => bindingPatternHasName(param, name))) ||
    (scope.type === "FunctionExpression" && bindingPatternHasName(scope.id, name)) ||
    functionBodyHasVarName(scope.body, name)
  );
}

function blockScopeHasName(scope: AstNode, name: string): boolean {
  if (scope.type !== "BlockStatement" || !Array.isArray(scope.body)) {
    return false;
  }
  return scope.body.some((statement) =>
    statement && typeof statement === "object"
      ? declarationHasName(statement as AstNode, name)
      : false
  );
}

function loopScopeHasName(scope: AstNode, name: string): boolean {
  const declaration = scope.type === "ForStatement" ? scope.init : scope.left;
  return (
    (scope.type === "ForStatement" ||
      scope.type === "ForInStatement" ||
      scope.type === "ForOfStatement") &&
    !!declaration &&
    typeof declaration === "object" &&
    declarationHasName(declaration as AstNode, name)
  );
}

function hasShadowingDeclaration(name: string, ancestors: AstNode[]): boolean {
  return ancestors.some(
    (scope) =>
      functionScopeHasName(scope, name) ||
      (scope.type === "CatchClause" && bindingPatternHasName(scope.param, name)) ||
      blockScopeHasName(scope, name) ||
      loopScopeHasName(scope, name)
  );
}

function isCreateRouteCall(
  node: CallExpression,
  bindings: RouteTransformBindings,
  ancestors: AstNode[]
): boolean {
  return (
    node.callee.type === "Identifier" &&
    bindings.createRouteNames.has(node.callee.name) &&
    !hasShadowingDeclaration(node.callee.name, ancestors)
  );
}

function isCreateRouteExpression(
  node: unknown,
  bindings: RouteTransformBindings,
  ancestors: AstNode[]
): boolean {
  if (!node || typeof node !== "object") {
    return false;
  }
  const expression = unwrapTSExpression(node as { type: string }) as AstNode;
  return (
    expression.type === "CallExpression" &&
    isCreateRouteCall(expression as unknown as CallExpression, bindings, ancestors)
  );
}

function collectLocalRouteBindings(program: Program, bindings: RouteTransformBindings): void {
  walk(program, {
    VariableDeclarator(node, context) {
      if (node.type !== "VariableDeclarator") {
        return;
      }
      const { id, init } = node;
      if (!id || typeof id !== "object") {
        return;
      }
      const identifier = id as unknown as AstNode;
      if (identifier.type !== "Identifier" || typeof identifier.name !== "string") {
        return;
      }
      if (isCreateRouteExpression(init, bindings, context.ancestors() as AstNode[])) {
        bindings.routeNames.add(identifier.name);
      }
    },
  });
}

function collectRouteTransformBindings(program: Program): RouteTransformBindings {
  const bindings = collectImportedBindings(program);
  collectLocalRouteBindings(program, bindings);
  return bindings;
}

function isRoutePageCall(
  node: CallExpression,
  bindings: RouteTransformBindings,
  ancestors: AstNode[]
): boolean {
  const { callee } = node;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "page"
  ) {
    const object = unwrapTSExpression(callee.object);
    if (
      object.type === "Identifier" &&
      bindings.routeNames.has(object.name) &&
      !hasShadowingDeclaration(object.name, ancestors)
    ) {
      return true;
    }
    return isCreateRouteExpression(object, bindings, ancestors);
  }
  return false;
}

function isTargetCall(
  node: CallExpression,
  bindings: RouteTransformBindings,
  ancestors: AstNode[]
): boolean {
  return isCreateRouteCall(node, bindings, ancestors) || isRoutePageCall(node, bindings, ancestors);
}

function isObjectExpressionNode(node: { type: string }): node is ObjectExpression {
  return node.type === "ObjectExpression";
}

function staticPropertyName(property: ObjectProperty): string | undefined {
  const { key } = property;
  if (key.type === "Identifier" && !property.computed && typeof key.name === "string") {
    return key.name;
  }
  if (key.type === "Literal" && typeof key.value === "string") {
    return key.value;
  }
}

function assertRoutePropertiesAreStaticallySafe(obj: ObjectExpression): void {
  for (const property of obj.properties) {
    if (property.type !== "Property") {
      throw new Error(
        "[furin] Route configuration spreads are not allowed because server-only properties cannot be stripped safely."
      );
    }
    if (property.computed && staticPropertyName(property) === undefined) {
      throw new Error(
        "[furin] A dynamic computed property in route configuration cannot be stripped safely."
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Remove server-only properties from an ObjectExpression using MagicString.
// Returns true if any property was removed.
// ---------------------------------------------------------------------------
function removeServerProperties(s: MagicString, source: string, obj: ObjectExpression): boolean {
  assertRoutePropertiesAreStaticallySafe(obj);

  const toRemove = obj.properties.filter((p): p is ObjectProperty => {
    if (p.type !== "Property") {
      return false;
    }
    const name = staticPropertyName(p);
    return name !== undefined && SERVER_ONLY_PROPERTIES.has(name);
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
        removeEnd += 1;
        break;
      }
      removeEnd += 1;
    }

    // Also remove leading whitespace (indentation before the property)
    let removeStart = prop.start;
    while (
      removeStart > 0 &&
      (source[removeStart - 1] === " " || source[removeStart - 1] === "\t")
    ) {
      removeStart -= 1;
    }
    // If there's a newline before the leading whitespace, consume it too
    if (removeStart > 0 && source[removeStart - 1] === "\n") {
      removeStart -= 1;
      if (removeStart > 0 && source[removeStart - 1] === "\r") {
        removeStart -= 1;
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
  "TSExpressionWithTypeArguments", // Babel ESTree shape for an implements clause
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
function collectReferencedNames(program: Program): Set<string> {
  const refs = new Set<string>();
  // Nodes that occupy a non-reference Identifier / JSXIdentifier position.
  const excluded = new Set<unknown>();

  for (const stmt of program.body) {
    if (stmt.type === "ImportDeclaration") {
      continue;
    }
    // Pass 1 — mark non-reference identifier positions.
    // Only exclude *static* keys (computed=false); computed keys like
    // `{ [someVar]: v }` are genuine identifier references.
    walkAST(stmt, (node) => {
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

  for (const stmt of program.body) {
    if (stmt.type === "ImportDeclaration") {
      continue;
    }
    // Pass 2 — collect genuine identifier references.
    walkAST(stmt, (node) => {
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
    removeEnd += 1;
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
      removeEnd += 1;
    }
    // react-doctor-disable-next-line react-doctor/js-set-map-lookups
    if (!code.slice(spec.end, removeEnd).includes(",")) {
      while (removeStart > 0 && (code[removeStart - 1] === " " || code[removeStart - 1] === ",")) {
        removeStart -= 1;
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
  const { program, diagnostics } = parseSource(code, lang);
  const firstError = diagnostics.find((d) => d.severity === "error");
  if (firstError) {
    console.error("[furin] DCE: failed to parse transformed output:", firstError.message);
    return s;
  }

  const fresh = new MagicString(code);
  const refs = collectReferencedNames(program);

  const { body } = program;
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const stmt = body[i];
    if (!stmt) {
      continue;
    }
    if (stmt.type !== "ImportDeclaration") {
      continue;
    }
    const decl = stmt as unknown as ImportDeclaration;
    if (decl.specifiers.length === 0) {
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
// Remove server-only properties from createRoute() / route.page()
// calls found anywhere in the AST.
// ---------------------------------------------------------------------------
function removeServerExports(s: MagicString, source: string, program: Program): boolean {
  let removedServerCode = false;
  const bindings = collectRouteTransformBindings(program);

  walk(program, {
    CallExpression(call, context) {
      if (!isTargetCall(call, bindings, context.ancestors() as AstNode[])) {
        return;
      }
      // Unwrap `createRoute({...} as Config)` / `route.page({...} satisfies Opts)` etc.
      const [firstArg] = call.arguments;
      if (!firstArg) {
        return;
      }
      const arg = unwrapTSExpression(firstArg);
      if (!isObjectExpressionNode(arg)) {
        return;
      }
      if (removeServerProperties(s, source, arg)) {
        removedServerCode = true;
      }
    },
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
  const { program, diagnostics } = parseSource(code, lang);
  const firstError = diagnostics.find((d) => d.severity === "error");
  if (firstError) {
    throw new Error(`Failed to parse ${filename}: ${firstError.message}`);
  }

  // Pass 2 — MagicString: surgically remove server-only properties.
  let s = new MagicString(code);
  const removedServerCode = removeServerExports(s, code, program);

  // Pass 3 — DCE: prune imports that are no longer referenced.
  // deadCodeElimination returns a fresh MagicString keyed on the current
  // output so its internal AST offsets remain consistent.
  if (removedServerCode) {
    s = deadCodeElimination(s, lang);
  }

  return {
    code: s.toString(),
    map: s.generateMap({ includeContent: true, source: filename }),
    removedServerCode,
  };
}
