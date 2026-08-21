import MagicString from "magic-string";
import type { ImportDeclaration, Program, SourceLang } from "yuku-parser";
import { parseSource } from "../shared/parser.ts";
import { type AstNode, walkAST } from "../shared/utils/ast-walk.ts";

const TYPE_SCOPE_NODES = new Set([
  "TSTypeAnnotation",
  "TSTypeParameterDeclaration",
  "TSTypeParameterInstantiation",
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
  "TSTypePredicate",
  "TSClassImplements",
  "TSExpressionWithTypeArguments",
]);

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
  const astNode = node as AstNode;
  if (astNode.type === "Identifier" || astNode.type === "JSXIdentifier") {
    excluded.add(astNode);
  }
  for (const key of Object.keys(astNode)) {
    if (key === "type" || key === "start" || key === "end") {
      continue;
    }
    markTypeDescendants(astNode[key], excluded);
  }
}

function excludeTypePositionIdentifiers(node: AstNode, excluded: Set<unknown>): void {
  if (TYPE_SCOPE_NODES.has(node.type)) {
    markTypeDescendants(node, excluded);
    return;
  }
  if (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSTypeAssertion"
  ) {
    markTypeDescendants(node.typeAnnotation as unknown, excluded);
  }
}

function collectReferencedNames(program: Program): Set<string> {
  const refs = new Set<string>();
  const excluded = new Set<unknown>();

  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") {
      continue;
    }
    walkAST(statement, (node) => {
      if (node.type === "Property" && !node.computed) {
        excluded.add(node.key);
      }
      if (node.type === "MemberExpression" && !node.computed) {
        excluded.add(node.property);
      }
      if (node.type === "JSXAttribute") {
        excluded.add(node.name);
      }
      if (node.type === "JSXMemberExpression") {
        excluded.add(node.property);
      }
      excludeTypePositionIdentifiers(node, excluded);
    });
  }

  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") {
      continue;
    }
    walkAST(statement, (node) => {
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

function preserveImportSideEffect(
  transformed: MagicString,
  code: string,
  declaration: ImportDeclaration
): void {
  transformed.overwrite(
    declaration.start,
    declaration.end,
    `import ${code.slice(declaration.source.start, declaration.source.end)};`
  );
}

function removeEntireImport(
  transformed: MagicString,
  code: string,
  declaration: ImportDeclaration
): void {
  let removeEnd = declaration.end;
  while (removeEnd < code.length && (code[removeEnd] === "\n" || code[removeEnd] === "\r")) {
    removeEnd += 1;
  }
  transformed.remove(declaration.start, removeEnd);
}

function removeUnusedSpecifiers(
  transformed: MagicString,
  code: string,
  declaration: ImportDeclaration,
  refs: Set<string>
): void {
  const removedSpecifiers = declaration.specifiers.filter(
    (specifier) => !refs.has(specifier.local.name)
  );
  for (const specifier of removedSpecifiers) {
    let removeStart = specifier.start;
    let removeEnd = specifier.end;
    while (removeEnd < code.length && (code[removeEnd] === "," || code[removeEnd] === " ")) {
      removeEnd += 1;
    }
    // react-doctor-disable-next-line react-doctor/js-set-map-lookups
    if (!code.slice(specifier.end, removeEnd).includes(",")) {
      while (removeStart > 0 && (code[removeStart - 1] === " " || code[removeStart - 1] === ",")) {
        removeStart -= 1;
      }
    }
    transformed.remove(removeStart, removeEnd);
  }
}

export function deadCodeElimination(
  transformed: MagicString,
  originalCode: string,
  lang: SourceLang
): MagicString {
  const code = transformed.toString();
  const { program, diagnostics } = parseSource(code, lang);
  const firstError = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (firstError) {
    console.error("[furin] DCE: failed to parse transformed output:", firstError.message);
    return transformed;
  }

  const pruned = new MagicString(code);
  const refs = collectReferencedNames(program);
  const originalParse = parseSource(originalCode, lang);
  const originalRefs = originalParse.diagnostics.some(
    (diagnostic) => diagnostic.severity === "error"
  )
    ? refs
    : collectReferencedNames(originalParse.program);

  for (let index = program.body.length - 1; index >= 0; index -= 1) {
    const statement = program.body[index];
    if (statement?.type !== "ImportDeclaration") {
      continue;
    }
    const declaration = statement as unknown as ImportDeclaration;
    if (declaration.specifiers.length === 0) {
      continue;
    }

    const usedCount = declaration.specifiers.filter((specifier) =>
      refs.has(specifier.local.name)
    ).length;
    if (usedCount === 0) {
      const typeOnly =
        declaration.importKind === "type" ||
        declaration.specifiers.every(
          (specifier) => (specifier as unknown as AstNode).importKind === "type"
        );
      const wasUsedBeforeTransform = declaration.specifiers.some((specifier) =>
        originalRefs.has(specifier.local.name)
      );
      if (typeOnly || wasUsedBeforeTransform) {
        removeEntireImport(pruned, code, declaration);
      } else {
        preserveImportSideEffect(pruned, code, declaration);
      }
    } else if (usedCount < declaration.specifiers.length) {
      removeUnusedSpecifiers(pruned, code, declaration, refs);
    }
  }

  return pruned;
}
