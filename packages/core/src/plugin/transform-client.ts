import MagicString from "magic-string";
import type {
  CallExpression,
  ImportDeclaration,
  ObjectExpression,
  ObjectProperty,
  Program,
} from "yuku-parser";
import { walk } from "yuku-parser";
import { detectLangFromPath, unwrapTSExpression } from "../server/lang-detect.ts";
import { parseSource } from "../shared/parser.ts";
import type { AstNode } from "../shared/utils/ast-walk.ts";
import { hasShadowingDeclaration } from "./binding-scope.ts";
import { deadCodeElimination } from "./dead-code-elimination.ts";
import { transformIsomorphicFunctions } from "./transform-isomorphic.ts";

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

  const isomorphicResult = transformIsomorphicFunctions(code, filename, "client");
  const clientSource = isomorphicResult.code;

  // Pass 1 — yuku-parser: parse TS/TSX/JS/JSX directly to ESTree AST with
  // span offsets calibrated against `code` itself (no transpile step).
  const { program, diagnostics } = parseSource(clientSource, lang);
  const firstError = diagnostics.find((d) => d.severity === "error");
  if (firstError) {
    throw new Error(`Failed to parse ${filename}: ${firstError.message}`);
  }

  // Pass 2 — MagicString: surgically remove server-only properties.
  let s = new MagicString(clientSource);
  const removedRouteCode = removeServerExports(s, clientSource, program);
  const removedServerCode = isomorphicResult.transformed || removedRouteCode;

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
