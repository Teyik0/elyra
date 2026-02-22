import { dirname, relative, resolve } from "node:path";
import { parseSync as oxcParseSync } from "oxc-parser";
import { transformSync as oxcTransformSync } from "oxc-transform";

// ---------------------------------------------------------------------------
// Top-level regex constants (satisfies lint/performance/useTopLevelRegex)
// ---------------------------------------------------------------------------
const RELATIVE_IMPORT_RE = /^(import\b[^'"]*?from\s*)(["'])(\.\.?\/[^"']+)\2/gm;
const IMPORT_META_HOT_RE = /if\s*\(import\.meta\.hot\)\s*\{/g;

const NAMED_COMPONENT_RE = /component\s*:\s*[A-Z][A-Za-z0-9_]*/;
const INLINE_COMPONENT_RE = /component\s*:\s*(?:\(|async\s*\(|function\b)/;
const PAGE_CALL_RE = /\bpage\s*\(|\bcreateRoute\s*\(/;

const REACT_DEFAULT_IMPORT_RE =
  /^import\s+(?:\*\s+as\s+)?React\s*,?\s*(?:\{[^}]*\})?\s*from\s*["']react["'];?\s*$/gm;
const REACT_NAMED_IMPORT_RE = /^import\s+\{[^}]*\}\s*from\s*["']react["'];?\s*$/gm;
const REACT_NAMESPACE_IMPORT_RE = /^import\s+(?:\*\s+as\s+)?React\s+from\s*["']react["'];?\s*$/gm;
const ELYSION_CLIENT_IMPORT_RE =
  /^import\s+\{[^}]*\}\s*from\s*["'](?:@[\w-]+\/)?elysion\/client["'];?\s*$/gm;
const ELYSIA_IMPORT_RE =
  /^import\s+(?:\*\s+as\s+\w+\s*,?\s*)?(?:\{[^}]*\})?\s*from\s*["'](?:@[\w-]+\/)?elysia["'];?\s*$/gm;
const CSS_IMPORT_RE = /^import\s+["'][^"']+\.css["'];?\s*$/gm;

export function detectFastPath(source: string): boolean {
  if (!PAGE_CALL_RE.test(source)) {
    return true;
  }
  if (NAMED_COMPONENT_RE.test(source)) {
    return true;
  }
  if (INLINE_COMPONENT_RE.test(source)) {
    return false;
  }
  return true;
}

function stripServerImports(code: string): string {
  let result = code;
  result = result.replace(REACT_DEFAULT_IMPORT_RE, "");
  result = result.replace(REACT_NAMED_IMPORT_RE, "");
  result = result.replace(REACT_NAMESPACE_IMPORT_RE, "");
  result = result.replace(ELYSION_CLIENT_IMPORT_RE, "");
  result = result.replace(ELYSIA_IMPORT_RE, "");
  result = result.replace(CSS_IMPORT_RE, "");
  return result;
}

function transformFastPath(
  code: string,
  filename: string,
  moduleId: string,
  srcDir: string,
  pagesDir: string
): string {
  const result = oxcTransformSync(filename, code, {
    jsx: {
      runtime: "classic",
      pragma: "React.createElement",
      pragmaFrag: "React.Fragment",
      development: true,
      refresh: {
        refreshReg: "$RefreshReg$",
        refreshSig: "$RefreshSig$",
        emitFullSignatures: true,
      },
    },
    sourcemap: true,
  });

  if (result.errors.length > 0) {
    const errorMessage = result.errors.map((e) => e.message).join("\n");
    throw new Error(`Transform error: ${errorMessage}`);
  }

  let transformedCode = result.code;

  if (result.map) {
    const mapBase64 = Buffer.from(JSON.stringify(result.map)).toString("base64");
    transformedCode += `\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${mapBase64}`;
  }

  transformedCode = stripServerImports(transformedCode);
  transformedCode = rewriteRelativeImports(transformedCode, filename, srcDir, pagesDir);
  transformedCode = stripImportMetaHotBlocks(transformedCode);

  const withGlobals = injectGlobals(transformedCode);
  return wrapWithHMR(withGlobals, moduleId);
}

type ESTreeNode = Record<string, unknown>;

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

function findComponentProperty(properties: ESTreeNode[]): ESTreeNode | null {
  for (const prop of properties) {
    if (prop.type === "Property") {
      const key = (prop as { key: ESTreeNode }).key;
      if (key?.type === "Identifier" && (key as { name: string }).name === "component") {
        return prop;
      }
    }
  }
  return null;
}

function extractComponentCode(code: string, compValue: ESTreeNode): string {
  const compParams = ((compValue as { params: ESTreeNode[] }).params || [])
    .map((p: ESTreeNode) => {
      const range = p.range as [number, number];
      return code.slice(range[0], range[1]);
    })
    .join(", ");

  const compBodyNode = (compValue as { body: ESTreeNode }).body;
  const compBodyRange = compBodyNode.range as [number, number];
  let compBody = code.slice(compBodyRange[0], compBodyRange[1]);

  if (compBodyNode.type !== "BlockStatement") {
    compBody = `{ return ${compBody}; }`;
  }

  return `function _ElysionPage(${compParams}) ${compBody}`;
}

function transformSlowPathOxc(
  code: string,
  filename: string,
  moduleId: string,
  srcDir: string,
  pagesDir: string
): string {
  const parseResult = oxcParseSync(filename, code, { astType: "ts", range: true });

  if (parseResult.errors.length > 0) {
    const errorMsg = parseResult.errors.map((e: { message: string }) => e.message).join("\n");
    throw new Error(`Parse error: ${errorMsg}`);
  }

  const program = parseResult.program as unknown as { body: ESTreeNode[] };

  const exportDecl = program.body.find((n: ESTreeNode) => n.type === "ExportDefaultDeclaration");
  if (!exportDecl) {
    return code;
  }

  const callExpr = exportDecl.declaration as ESTreeNode;
  if (callExpr?.type !== "CallExpression") {
    return code;
  }

  const callee = callExpr.callee as ESTreeNode;
  if (!isPageCall(callee)) {
    return code;
  }

  const args = callExpr.arguments as ESTreeNode[];
  const objArg = args[0];
  if (!objArg || objArg.type !== "ObjectExpression") {
    return code;
  }

  const properties = (objArg as { properties: ESTreeNode[] }).properties;
  const componentProp = findComponentProperty(properties);
  if (!componentProp) {
    return code;
  }

  const compValue = (componentProp as { value: ESTreeNode }).value;
  const isInline =
    compValue?.type === "ArrowFunctionExpression" || compValue?.type === "FunctionExpression";
  if (!isInline) {
    return code;
  }

  const namedFunc = extractComponentCode(code, compValue);

  const preservedNodes = program.body.filter((n: ESTreeNode) => {
    if (n.type === "ExportDefaultDeclaration") {
      return false;
    }
    return (
      n.type === "ImportDeclaration" ||
      n.type === "FunctionDeclaration" ||
      n.type === "VariableDeclaration" ||
      n.type === "ClassDeclaration" ||
      n.type === "TSTypeAliasDeclaration" ||
      n.type === "TSInterfaceDeclaration" ||
      n.type === "TSEnumDeclaration"
    );
  });

  const preservedCode = preservedNodes
    .map((n: ESTreeNode) => {
      const range = n.range as [number, number];
      return code.slice(range[0], range[1]);
    })
    .join("\n\n");

  let modifiedCode = preservedCode;
  if (preservedCode) {
    modifiedCode += "\n\n";
  }
  modifiedCode += `${namedFunc}\nexport default route.page({ component: _ElysionPage });`;

  const transformResult = oxcTransformSync(filename, modifiedCode, {
    jsx: {
      runtime: "classic",
      pragma: "React.createElement",
      pragmaFrag: "React.Fragment",
      development: true,
      refresh: {
        refreshReg: "$RefreshReg$",
        refreshSig: "$RefreshSig$",
        emitFullSignatures: true,
      },
    },
    sourcemap: true,
  });

  if (transformResult.errors.length > 0) {
    const errorMsg = transformResult.errors.map((e: { message: string }) => e.message).join("\n");
    throw new Error(`Transform error: ${errorMsg}`);
  }

  let output = transformResult.code;

  if (transformResult.map) {
    const mapBase64 = Buffer.from(JSON.stringify(transformResult.map)).toString("base64");
    output += `\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${mapBase64}`;
  }

  output = removeUnusedImportsOxc(output);
  output = stripServerImports(output);
  output = rewriteRelativeImports(output, filename, srcDir, pagesDir);
  output = stripImportMetaHotBlocks(output);
  output += '\n$RefreshReg$(_ElysionPage, "_ElysionPage");';

  const withGlobals = injectGlobals(output);
  return wrapWithHMR(withGlobals, moduleId);
}

function removeUnusedImportsOxc(code: string): string {
  const result = oxcParseSync("temp.js", code, { astType: "js", range: true });
  if (result.errors.length > 0) {
    return code;
  }

  const program = result.program as unknown as { body: ESTreeNode[] };
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
      collectIdentifiersOxc(node, usedIdentifiers);
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

function collectIdentifiersOxc(node: ESTreeNode, set: Set<string>): void {
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
    const val = node[key as keyof typeof node];
    if (Array.isArray(val)) {
      for (const v of val) {
        collectIdentifiersOxc(v as ESTreeNode, set);
      }
    } else if (val && typeof val === "object") {
      collectIdentifiersOxc(val as ESTreeNode, set);
    }
  }
}

// ---------------------------------------------------------------------------
// Relative import rewriting
// ---------------------------------------------------------------------------

function rewriteRelativeImports(
  code: string,
  filePath: string,
  srcDir: string,
  _pagesDir: string
): string {
  const fileDir = dirname(filePath);

  return code.replace(RELATIVE_IMPORT_RE, (match, prefix, quote, importPath) => {
    const absoluteImportPath = resolve(fileDir, importPath);

    if (!absoluteImportPath.startsWith(srcDir)) {
      return match;
    }

    const relativeToSrc = relative(srcDir, absoluteImportPath).replace(/\\/g, "/");
    return `${prefix}${quote}/_modules/src/${relativeToSrc}${quote}`;
  });
}

// ---------------------------------------------------------------------------
// Main transform entry point
// ---------------------------------------------------------------------------

export function transformForReactRefresh(
  code: string,
  filename: string,
  moduleId: string,
  srcDir: string,
  pagesDir: string
): string {
  try {
    if (detectFastPath(code)) {
      return transformFastPath(code, filename, moduleId, srcDir, pagesDir);
    }

    return transformSlowPathOxc(code, filename, moduleId, srcDir, pagesDir);
  } catch (error) {
    console.error(`[hmr:transform] Error transforming ${filename}:`, error);
    throw error;
  }
}

function injectGlobals(code: string): string {
  const reactDecl = "const React = window.React;";
  const hooksDecl =
    "const { useState, useEffect, useCallback, useMemo, useRef, useContext, useReducer, useLayoutEffect, useImperativeHandle, useDebugValue, useDeferredValue, useTransition, useId, useSyncExternalStore, useInsertionEffect, createElement, Fragment } = window.React;";
  const elysionDecl = "const { createRoute } = window.__ELYSION__;";
  const elysiaStub = "const t = new Proxy({}, { get: () => (...args) => args[0] ?? {} });";

  return `${reactDecl}\n${hooksDecl}\n${elysionDecl}\n${elysiaStub}\n${code}`;
}

function stripImportMetaHotBlocks(code: string): string {
  let result = "";
  let lastIndex = 0;

  for (const match of code.matchAll(IMPORT_META_HOT_RE)) {
    const matchIndex = match.index;
    if (matchIndex === undefined) {
      continue;
    }

    result += code.slice(lastIndex, matchIndex);

    let depth = 1;
    const start = matchIndex + match[0].length;
    let end = start;

    for (let i = start; i < code.length; i++) {
      if (code[i] === "{") {
        depth++;
      } else if (code[i] === "}") {
        depth--;
      }
      if (depth === 0) {
        end = i;
        break;
      }
    }

    lastIndex = end + 1;
  }

  return result + code.slice(lastIndex);
}

function wrapWithHMR(code: string, moduleId: string): string {
  return `
// HMR Runtime Setup for ${moduleId}
const prevRefreshReg = window.$RefreshReg$;
const prevRefreshSig = window.$RefreshSig$;

// Use stable module ID from window.__CURRENT_MODULE__ (set before import)
const __hmrModuleId = window.__CURRENT_MODULE__ || ${JSON.stringify(moduleId)};

// Scoped refresh functions for this module
var $RefreshReg$ = (type, id) => {
  const fullId = __hmrModuleId + ' ' + id;
  if (window.__REFRESH_RUNTIME__) {
    window.__REFRESH_RUNTIME__.register(type, fullId);
  }
};

var $RefreshSig$ = window.__REFRESH_RUNTIME__
  ? window.__REFRESH_RUNTIME__.createSignatureFunctionForTransform
  : () => (type) => type;

${code}

window.$RefreshReg$ = prevRefreshReg;
window.$RefreshSig$ = prevRefreshSig;
`;
}
