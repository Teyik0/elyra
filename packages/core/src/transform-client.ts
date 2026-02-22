import { parseSync as oxcParseSync } from "oxc-parser";

type ESTreeNode = Record<string, unknown>;

const SERVER_ONLY_PROPERTIES = ["loader"];
const WHITESPACE_COMMA_RE = /[\s,]/;

interface TransformResult {
  code: string;
  map: null;
  removedServerCode: boolean;
}

function isPageCall(callee: ESTreeNode): boolean {
  if (callee?.type === "Identifier" && (callee as { name: string }).name === "page") {
    return true;
  }
  if (callee?.type === "MemberExpression") {
    const prop = (callee as { property: ESTreeNode }).property;
    return prop?.type === "Identifier" && (prop as { name: string }).name === "page";
  }
  return false;
}

function isCreateRouteCall(callee: ESTreeNode): boolean {
  return callee?.type === "Identifier" && (callee as { name: string }).name === "createRoute";
}

function expandRangeToIncludeComma(code: string, range: [number, number]): [number, number] {
  let start = range[0];
  let end = range[1];

  while (start > 0 && WHITESPACE_COMMA_RE.test(code[start - 1] ?? "")) {
    start--;
  }
  if (code[start] === ",") {
    start++;
  }

  while (end < code.length && WHITESPACE_COMMA_RE.test(code[end] ?? "")) {
    end++;
  }
  if (code[end] === ",") {
    end++;
  }

  return [start, end];
}

function findLoaderPropertyRanges(code: string, properties: ESTreeNode[]): [number, number][] {
  const ranges: [number, number][] = [];

  for (const prop of properties) {
    if (prop?.type !== "Property") {
      continue;
    }

    const key = (prop as { key: ESTreeNode }).key;
    if (key?.type !== "Identifier") {
      continue;
    }

    const keyName = (key as { name: string }).name;
    if (!SERVER_ONLY_PROPERTIES.includes(keyName)) {
      continue;
    }

    const propRange = prop.range as [number, number];
    const expandedRange = expandRangeToIncludeComma(code, propRange);
    ranges.push(expandedRange);
  }

  return ranges;
}

function collectUsedIdentifiers(node: ESTreeNode, set: Set<string>): void {
  if (!node || typeof node !== "object") {
    return;
  }

  if (node.type === "Identifier") {
    const name = (node as { name?: string }).name;
    if (name) {
      set.add(name);
    }
  }

  for (const key of Object.keys(node)) {
    if (key === "ImportDeclaration") {
      continue;
    }
    const val = node[key as keyof typeof node];
    if (Array.isArray(val)) {
      for (const v of val) {
        collectUsedIdentifiers(v as ESTreeNode, set);
      }
    } else if (val && typeof val === "object") {
      collectUsedIdentifiers(val as ESTreeNode, set);
    }
  }
}

function removeUnusedImports(code: string, program: { body: ESTreeNode[] }): string {
  const imports: { range: [number, number]; specifiers: { name: string }[] }[] = [];
  const usedIdentifiers = new Set<string>();

  for (const node of program.body) {
    if (node.type === "ImportDeclaration") {
      const specs = ((node as { specifiers: ESTreeNode[] }).specifiers || [])
        .map((s: ESTreeNode) => ({
          name: (s as { local?: { name: string } }).local?.name,
        }))
        .filter((s): s is { name: string } => !!s.name);

      imports.push({
        range: node.range as [number, number],
        specifiers: specs,
      });
    } else {
      collectUsedIdentifiers(node, usedIdentifiers);
    }
  }

  const toRemove: [number, number][] = imports
    .filter((imp) => !imp.specifiers.some((s) => usedIdentifiers.has(s.name)))
    .map((imp) => imp.range);

  toRemove.sort((a, b) => b[0] - a[0]);

  let modified = code;
  for (const range of toRemove) {
    modified = modified.slice(0, range[0]) + modified.slice(range[1]);
  }

  return modified.replace(/\n\s*\n/g, "\n");
}

function extractCallExpressionArgs(node: ESTreeNode): ESTreeNode[] | null {
  if (node.type !== "CallExpression") {
    return null;
  }

  const callee = (node as { callee: ESTreeNode }).callee;
  if (!(isPageCall(callee) || isCreateRouteCall(callee))) {
    return null;
  }

  const args = (node as { arguments?: ESTreeNode[] }).arguments;
  return args ?? null;
}

function processCallExpression(code: string, node: ESTreeNode): [number, number][] {
  const args = extractCallExpressionArgs(node);
  if (!args) {
    return [];
  }

  const arg = args[0];
  if (arg?.type !== "ObjectExpression") {
    return [];
  }

  return findLoaderPropertyRanges(code, (arg as { properties: ESTreeNode[] }).properties);
}

function processVariableDeclaration(code: string, node: ESTreeNode): [number, number][] {
  const decls = (node as { declarations?: ESTreeNode[] }).declarations || [];
  const ranges: [number, number][] = [];

  for (const decl of decls) {
    const init = (decl as { init?: ESTreeNode }).init;
    if (init) {
      ranges.push(...processCallExpression(code, init));
    }
  }

  return ranges;
}

function findServerPropertyRanges(code: string, node: ESTreeNode): [number, number][] {
  if (node.type === "ExportDefaultDeclaration") {
    const decl = (node as { declaration?: ESTreeNode }).declaration;
    if (decl) {
      return processCallExpression(code, decl);
    }
  }

  if (node.type === "CallExpression") {
    return processCallExpression(code, node);
  }

  if (node.type === "VariableDeclaration") {
    return processVariableDeclaration(code, node);
  }

  return [];
}

export function transformForClient(code: string, filename: string): TransformResult {
  const parseResult = oxcParseSync(filename, code, { astType: "ts", range: true });

  const firstError = parseResult.errors[0];
  if (firstError) {
    throw new Error(`Failed to parse ${filename}: ${firstError.message}`);
  }

  const program = parseResult.program as unknown as { body: ESTreeNode[] };

  const serverPropertyRanges: [number, number][] = [];
  for (const node of program.body) {
    serverPropertyRanges.push(...findServerPropertyRanges(code, node));
  }

  const removedServerCode = serverPropertyRanges.length > 0;

  let output = code;

  if (removedServerCode) {
    serverPropertyRanges.sort((a, b) => b[0] - a[0]);

    for (const range of serverPropertyRanges) {
      output = output.slice(0, range[0]) + output.slice(range[1]);
    }

    output = output.replace(/,\s*([})])/g, "$1");
    output = output.replace(/([{[])\s*,/g, "$1");

    const reparseResult = oxcParseSync(filename, output, { astType: "ts", range: true });
    if (reparseResult.errors.length === 0) {
      output = removeUnusedImports(
        output,
        reparseResult.program as unknown as { body: ESTreeNode[] }
      );
    }
  }

  return {
    code: output,
    map: null,
    removedServerCode,
  };
}
