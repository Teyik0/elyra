import { dirname, relative, resolve } from "node:path";
import type * as Babel from "@babel/core";
import { transformSync } from "@babel/core";
import type { NodePath } from "@babel/traverse";
import {
  blockStatement,
  functionDeclaration,
  isArrowFunctionExpression,
  isBlockStatement,
  isCallExpression,
  isFunctionExpression,
  isIdentifier,
  isMemberExpression,
  isObjectExpression,
  isObjectProperty,
  isProgram,
  returnStatement,
} from "@babel/types";

const presetTypescript = require.resolve("@babel/preset-typescript");
const presetReact = require.resolve("@babel/preset-react");
const reactRefreshBabelPlugin = require.resolve("react-refresh/babel");

// --- Module-level regex constants ---

// rewriteRelativeImports
const RELATIVE_IMPORT_RE = /^(import\b[^'"]*?from\s*)(["'])(\.\.?\/[^"']+)\2/gm;

// removeUnusedImports: import line detection and specifier shape detection
const IMPORT_LINE_RE = /^import\s+(.+?)\s+from\s*["'][^"']+["'];?\s*$/;
const NAMED_SPECIFIERS_RE = /^\{([^}]+)\}$/;
const DEFAULT_WITH_NAMED_RE = /^(\w+)(?:\s*,\s*\{([^}]+)\})?$/;
const NAMESPACE_IMPORT_RE = /^\*\s+as\s+(\w+)$/;

// removeUnusedImports: stripping code for identifier usage analysis
const STRIP_LINE_COMMENT_RE = /\/\/[^\n]*/g;
const STRIP_BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const STRIP_STRING_LITERAL_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const ESCAPE_REGEX_META_RE = /[.*+?^${}()|[\]\\]/g;

// transformForReactRefresh: strip server-side import patterns
const STRIP_REACT_STAR_IMPORT_RE =
  /^import\s+(?:\*\s+as\s+)?React\s*,?\s*(?:\{[^}]*\})?\s*from\s*["']react["'];?\s*$/gm;
const STRIP_REACT_NAMED_IMPORT_RE = /^import\s+\{[^}]*\}\s*from\s*["']react["'];?\s*$/gm;
const STRIP_REACT_DEFAULT_IMPORT_RE =
  /^import\s+(?:\*\s+as\s+)?React\s+from\s*["']react["'];?\s*$/gm;
const STRIP_ELYSION_CLIENT_IMPORT_RE =
  /^import\s+\{[^}]*\}\s*from\s*["']elysion\/client["'];?\s*$/gm;
const STRIP_ELYSIA_IMPORT_RE = /^import\s+\{[^}]*\}\s*from\s*["']elysia["'];?\s*$/gm;
const STRIP_CSS_IMPORT_RE = /^import\s+["'][^"']+\.css["'];?\s*$/gm;

// stripImportMetaHotBlocks
const HOT_BLOCK_RE = /if\s*\(import\.meta\.hot\)\s*\{/g;

// parseNamedSpecifiers / parseDefaultWithNamedSpecifiers
const AS_SEPARATOR_RE = /\s+as\s+/;

function findObjectProperty(
  obj: Babel.types.ObjectExpression,
  name: string
): Babel.types.ObjectProperty | undefined {
  return obj.properties.find(
    (p): p is Babel.types.ObjectProperty => isObjectProperty(p) && isIdentifier(p.key, { name })
  );
}

function removeServerProperties(obj: Babel.types.ObjectExpression, properties: string[]): boolean {
  let removed = false;
  for (const name of properties) {
    const prop = findObjectProperty(obj, name);
    if (prop) {
      const idx = obj.properties.indexOf(prop);
      if (idx !== -1) {
        obj.properties.splice(idx, 1);
        removed = true;
      }
    }
  }
  return removed;
}

function findComponentProperty(arg: Babel.types.Expression): Babel.types.ObjectProperty | null {
  if (!isObjectExpression(arg)) {
    return null;
  }
  const prop = arg.properties.find(
    (p): p is Babel.types.ObjectProperty =>
      isObjectProperty(p) && isIdentifier(p.key, { name: "component" })
  );
  return prop ?? null;
}

function shouldExtractComponent(value: Babel.types.Node): boolean {
  if (isIdentifier(value)) {
    return false;
  }
  return isArrowFunctionExpression(value) || isFunctionExpression(value);
}

function createNamedFunctionFromArrow(
  params: Babel.types.ArrowFunctionExpression["params"],
  body: Babel.types.ArrowFunctionExpression["body"],
  name: Babel.types.Identifier
): Babel.types.FunctionDeclaration {
  const functionBody = isBlockStatement(body) ? body : blockStatement([returnStatement(body)]);
  return functionDeclaration(name, params, functionBody);
}

function insertFunctionBeforeExport(
  path: NodePath<Babel.types.ExportDefaultDeclaration>,
  fn: Babel.types.FunctionDeclaration
): void {
  const program = path.parentPath;
  if (!(program && isProgram(program.node))) {
    return;
  }
  path.insertBefore(fn);
}

const SERVER_ONLY_PROPERTIES = ["loader"];

/**
 * Handles: export default page({ component: ..., loader: ... })
 * Strips server properties and extracts the component to a named function.
 */
function handlePageExportDefault(
  path: NodePath<Babel.types.ExportDefaultDeclaration>,
  arg:
    | Babel.types.Expression
    | Babel.types.SpreadElement
    | Babel.types.JSXNamespacedName
    | Babel.types.ArgumentPlaceholder
    | undefined,
  onExtract: (name: string) => void
): void {
  if (!isObjectExpression(arg)) {
    return;
  }
  removeServerProperties(arg, SERVER_ONLY_PROPERTIES);

  const componentProp = findComponentProperty(arg);
  if (!componentProp) {
    return;
  }

  const componentValue = componentProp.value;
  if (!shouldExtractComponent(componentValue)) {
    return;
  }

  if (isArrowFunctionExpression(componentValue) || isFunctionExpression(componentValue)) {
    const extractedName = path.scope.generateUidIdentifier("ElysionPage");
    onExtract(extractedName.name);
    const namedFunction = createNamedFunctionFromArrow(
      componentValue.params,
      componentValue.body,
      extractedName
    );
    componentProp.value = extractedName;
    insertFunctionBeforeExport(path, namedFunction);
  }
}

/**
 * Handles: export default route.page({ loader: ... })
 * Strips server-only properties.
 */
function handleRouteDotPageExportDefault(
  arg:
    | Babel.types.Expression
    | Babel.types.SpreadElement
    | Babel.types.JSXNamespacedName
    | Babel.types.ArgumentPlaceholder
    | undefined
): void {
  if (isObjectExpression(arg)) {
    removeServerProperties(arg, SERVER_ONLY_PROPERTIES);
  }
}

/**
 * Handles: export default createRoute({ loader: ... })
 * Strips server-only properties.
 */
function handleCreateRouteExportDefault(
  arg:
    | Babel.types.Expression
    | Babel.types.SpreadElement
    | Babel.types.JSXNamespacedName
    | Babel.types.ArgumentPlaceholder
    | undefined
): void {
  if (isObjectExpression(arg)) {
    removeServerProperties(arg, SERVER_ONLY_PROPERTIES);
  }
}

function createExtractPlugin(onExtract: (name: string) => void): Babel.PluginObj {
  return {
    name: "extract-page-component",
    visitor: {
      ExportDefaultDeclaration(path) {
        const decl = path.node.declaration;
        if (!isCallExpression(decl)) {
          return;
        }

        const arg = decl.arguments[0];
        const callee = decl.callee;

        if (isIdentifier(callee, { name: "page" })) {
          handlePageExportDefault(path, arg, onExtract);
          return;
        }

        if (isMemberExpression(callee) && isIdentifier(callee.property, { name: "page" })) {
          handleRouteDotPageExportDefault(arg);
          return;
        }

        if (isIdentifier(callee, { name: "createRoute" })) {
          handleCreateRouteExportDefault(arg);
        }
      },

      CallExpression(path) {
        const node = path.node;
        const parent = path.parent;

        if (parent?.type === "ExportDefaultDeclaration") {
          return;
        }

        const callee = node.callee;
        const arg = node.arguments[0];

        if (isIdentifier(callee, { name: "page" })) {
          if (isObjectExpression(arg)) {
            removeServerProperties(arg, SERVER_ONLY_PROPERTIES);
          }
        } else if (isMemberExpression(callee) && isIdentifier(callee.property, { name: "page" })) {
          if (isObjectExpression(arg)) {
            removeServerProperties(arg, SERVER_ONLY_PROPERTIES);
          }
        } else if (isIdentifier(callee, { name: "createRoute" }) && isObjectExpression(arg)) {
          removeServerProperties(arg, SERVER_ONLY_PROPERTIES);
        }
      },
    },
  };
}

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

function parseNamedSpecifiers(specStr: string): string[] | null {
  const match = specStr.match(NAMED_SPECIFIERS_RE);
  if (!match?.[1]) {
    return null;
  }
  const result: string[] = [];
  for (const spec of match[1].split(",")) {
    const trimmed = spec.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split(AS_SEPARATOR_RE);
    const localName = (parts.length > 1 ? parts[1] : parts[0])?.trim();
    if (localName) {
      result.push(localName);
    }
  }
  return result;
}

function parseDefaultWithNamedSpecifiers(specStr: string): string[] | null {
  const match = specStr.match(DEFAULT_WITH_NAMED_RE);
  if (!match?.[1]) {
    return null;
  }
  const result: string[] = [match[1]];
  if (match[2]) {
    for (const spec of match[2].split(",")) {
      const trimmed = spec.trim();
      if (!trimmed) {
        continue;
      }
      const parts = trimmed.split(AS_SEPARATOR_RE);
      const localName = (parts.length > 1 ? parts[1] : parts[0])?.trim();
      if (localName) {
        result.push(localName);
      }
    }
  }
  return result;
}

function parseNamespaceSpecifier(specStr: string): string[] | null {
  const match = specStr.match(NAMESPACE_IMPORT_RE);
  return match?.[1] ? [match[1]] : null;
}

function parseImportSpecifiers(specStr: string): string[] {
  return (
    parseNamedSpecifiers(specStr) ??
    parseDefaultWithNamedSpecifiers(specStr) ??
    parseNamespaceSpecifier(specStr) ??
    []
  );
}

function stripCodeForAnalysis(code: string): string {
  // Strip comments and string literals so identifiers inside them don't
  // count as "used" (avoids false positives that prevent import removal)
  return code
    .replace(STRIP_LINE_COMMENT_RE, "")
    .replace(STRIP_BLOCK_COMMENT_RE, "")
    .replace(STRIP_STRING_LITERAL_RE, '""');
}

function findUsedIdentifiers(strippedCode: string, allIdentifiers: Set<string>): Set<string> {
  const used = new Set<string>();
  for (const name of allIdentifiers) {
    // Escape regex metacharacters in the identifier (e.g. $store, $t)
    const escapedName = name.replace(ESCAPE_REGEX_META_RE, "\\$&");
    const regex = new RegExp(`\\b${escapedName}\\b`, "g");
    if (strippedCode.match(regex)) {
      used.add(name);
    }
  }
  return used;
}

function removeUnusedImports(code: string): string {
  const lines = code.split("\n");
  const importLines = new Map<number, string[]>();
  const allIdentifiers = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      continue;
    }
    const match = line.match(IMPORT_LINE_RE);
    if (!match?.[1]) {
      continue;
    }
    const identifiers = parseImportSpecifiers(match[1]);
    if (identifiers.length > 0) {
      importLines.set(i, identifiers);
      for (const id of identifiers) {
        allIdentifiers.add(id);
      }
    }
  }

  const codeWithoutImports = lines.filter((_, i) => !importLines.has(i)).join("\n");
  const strippedCode = stripCodeForAnalysis(codeWithoutImports);
  const usedIdentifiers = findUsedIdentifiers(strippedCode, allIdentifiers);

  for (const [index, identifiers] of importLines) {
    const usedFromThisLine = identifiers.filter((id) => usedIdentifiers.has(id));
    if (usedFromThisLine.length === 0) {
      lines[index] = "";
    }
  }

  return lines.join("\n");
}

export function transformForReactRefresh(
  code: string,
  filename: string,
  moduleId: string,
  srcDir: string,
  pagesDir: string
): string {
  try {
    let extractedComponentName: string | null = null;

    // Pass 1: Extract component from page() call
    const extractResult = transformSync(code, {
      filename,
      presets: [[presetTypescript, { isTSX: true, allExtensions: true }]],
      plugins: [
        createExtractPlugin((name) => {
          extractedComponentName = name;
        }),
      ],
      sourceMaps: false,
    });

    if (!extractResult?.code) {
      throw new Error("Extract transform failed");
    }

    // Pass 2: Transform JSX and add React Refresh (TypeScript already stripped in Pass 1)
    const result = transformSync(extractResult.code, {
      filename,
      presets: [[presetReact, { runtime: "classic" }]],
      plugins: [[reactRefreshBabelPlugin, { skipEnvCheck: true }]],
      sourceMaps: "inline",
    });

    if (!result?.code) {
      throw new Error("JSX transform failed");
    }

    let transformedCode = result.code;

    // Add manual registration for extracted component
    if (extractedComponentName) {
      const functionEndPattern = new RegExp(`(_s\\(${extractedComponentName},[^;]+\\);?)`, "g");
      transformedCode = transformedCode.replace(functionEndPattern, (match: string) => {
        return `${match}\n$RefreshReg$(${extractedComponentName}, "${extractedComponentName}");`;
      });
    }

    // Strip React imports
    transformedCode = transformedCode.replace(STRIP_REACT_STAR_IMPORT_RE, "");
    transformedCode = transformedCode.replace(STRIP_REACT_NAMED_IMPORT_RE, "");
    transformedCode = transformedCode.replace(STRIP_REACT_DEFAULT_IMPORT_RE, "");

    // Strip elysion/client imports
    transformedCode = transformedCode.replace(STRIP_ELYSION_CLIENT_IMPORT_RE, "");

    // Strip elysia imports (server-only)
    transformedCode = transformedCode.replace(STRIP_ELYSIA_IMPORT_RE, "");

    // Strip CSS imports
    transformedCode = transformedCode.replace(STRIP_CSS_IMPORT_RE, "");

    // Remove unused imports (after loader removal)
    transformedCode = removeUnusedImports(transformedCode);

    // Rewrite relative imports to /_modules/src/ absolute URLs so the browser
    // can fetch them through the HMR module server
    transformedCode = rewriteRelativeImports(transformedCode, filename, srcDir, pagesDir);

    // Strip import.meta.hot blocks (handles nested braces)
    transformedCode = stripImportMetaHotBlocks(transformedCode);

    const withGlobals = injectGlobals(transformedCode);
    return wrapWithHMR(withGlobals, moduleId);
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

  for (const match of code.matchAll(HOT_BLOCK_RE)) {
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
