import { dirname, relative, resolve } from "node:path";
import type * as Babel from "@babel/core";
import { transformSync } from "@babel/core";
import generate from "@babel/generator";
import type { NodePath } from "@babel/traverse";
import traverseModule from "@babel/traverse";
import type * as t from "@babel/types";
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
import { deadCodeElimination } from "../transform-client";

const reactRefreshBabelPlugin = require.resolve("react-refresh/babel");

// ---------------------------------------------------------------------------
// Bun.Transpiler singleton — reused across calls (cheaper than recreating).
// Handles TypeScript stripping + JSX → React.createElement in one native pass,
// replacing @babel/preset-typescript + @babel/preset-react entirely.
// trimUnusedImports removes type-only and structurally dead imports via the
// native Bun parser (no regex needed).
// ---------------------------------------------------------------------------
// The project tsconfig uses "jsx": "react-jsx" (automatic runtime), which
// makes Bun.Transpiler emit jsxDEV / jsx calls from react/jsx-dev-runtime.
// Those imports are then stripped by our server-import regex, leaving
// undefined references at runtime. Override via the tsconfig option to force
// the classic transform (React.createElement) that the HMR globals provide.
const bunTranspiler = new Bun.Transpiler({
  loader: "tsx",
  trimUnusedImports: true,
  tsconfig: {
    compilerOptions: {
      jsx: "react",
      jsxFactory: "React.createElement",
      jsxFragmentFactory: "React.Fragment",
    },
  },
});

// ---------------------------------------------------------------------------
// Top-level regex constants (satisfies lint/performance/useTopLevelRegex)
// ---------------------------------------------------------------------------
const RELATIVE_IMPORT_RE = /^(import\b[^'"]*?from\s*)(["'])(\.\.?\/[^"']+)\2/gm;
const IMPORT_META_HOT_RE = /if\s*\(import\.meta\.hot\)\s*\{/g;

// ---------------------------------------------------------------------------
// Babel AST helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Component extraction from page() calls
// ---------------------------------------------------------------------------

function handlePageCallExtraction(
  path: NodePath<Babel.types.ExportDefaultDeclaration>,
  arg: Babel.types.Expression,
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

  const extractedName = path.scope.generateUidIdentifier("ElysionPage");
  onExtract(extractedName.name);

  if (isArrowFunctionExpression(componentValue) || isFunctionExpression(componentValue)) {
    const namedFunction = createNamedFunctionFromArrow(
      componentValue.params,
      componentValue.body,
      extractedName
    );
    componentProp.value = extractedName;
    insertFunctionBeforeExport(path, namedFunction);
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
          handlePageCallExtraction(path, arg as Babel.types.Expression, onExtract);
          return;
        }

        if (isMemberExpression(callee) && isIdentifier(callee.property, { name: "page" })) {
          if (isObjectExpression(arg)) {
            removeServerProperties(arg, SERVER_ONLY_PROPERTIES);
          }
          return;
        }

        if (isIdentifier(callee, { name: "createRoute" }) && isObjectExpression(arg)) {
          removeServerProperties(arg, SERVER_ONLY_PROPERTIES);
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
    let extractedComponentName: string | null = null;

    // Pass 1 — Bun.Transpiler: TypeScript + JSX → plain JS (native, ~10-50× faster
    // than Babel preset-typescript + preset-react). trimUnusedImports removes
    // type-only and structurally-dead imports at parse time.
    const plainJs = bunTranspiler.transformSync(code);

    // Pass 2 — Babel (extraction + DCE): strip server-only properties (loader),
    // lift the inline arrow component into a named function declaration, then
    // remove any imports that became orphaned after loader removal (e.g. db.ts
    // imported only by the loader must not reach the browser bundle).
    //
    // We request ast:true so we can apply deadCodeElimination on the same AST
    // before generating code for Pass 3 — avoids a redundant parse/generate cycle.
    const extractResult = transformSync(plainJs, {
      filename,
      plugins: [
        createExtractPlugin((name) => {
          extractedComponentName = name;
        }),
      ],
      ast: true,
      code: false,
      sourceMaps: false,
    });

    if (!extractResult?.ast) {
      throw new Error("Extract transform failed");
    }

    // Re-crawl the scope so Babel's binding references reflect the removed loader,
    // then eliminate imports whose only consumer was the now-removed loader.
    const extractedAst = extractResult.ast as t.File;
    const traverse =
      // @babel/traverse ships both a default export and a .default property
      // depending on the module format — normalise to whichever is callable.
      typeof traverseModule === "function"
        ? traverseModule
        : (traverseModule as { default: typeof traverseModule }).default;
    traverse(extractedAst, {
      Program(p) {
        p.scope.crawl();
      },
    });
    deadCodeElimination(extractedAst);

    const cleanedCode = generate(extractedAst).code;

    // Pass 3 — Babel (React Refresh only): instrument all visible function
    // components, including the _ElysionPage extracted in Pass 2.
    // No presets required — TS and JSX are already plain JS from Pass 1.
    const result = transformSync(cleanedCode, {
      filename,
      plugins: [[reactRefreshBabelPlugin, { skipEnvCheck: true }]],
      sourceMaps: "inline",
    });

    if (!result?.code) {
      throw new Error("React Refresh transform failed");
    }

    let transformedCode = result.code;

    // Add manual registration for extracted component
    if (extractedComponentName) {
      const functionEndPattern = new RegExp(`(_s\\(${extractedComponentName},[^;]+\\);?)`, "g");
      transformedCode = transformedCode.replace(functionEndPattern, (match: string) => {
        return `${match}\n$RefreshReg$(${extractedComponentName}, "${extractedComponentName}");`;
      });
    }

    // Strip server-only imports that must never reach the browser.
    // React: replaced by window.React global injected below.
    // elysion/client + elysia: server-only APIs.
    // CSS: handled separately by the CSS pipeline.
    transformedCode = transformedCode.replace(
      /^import\s+(?:\*\s+as\s+)?React\s*,?\s*(?:\{[^}]*\})?\s*from\s*["']react["'];?\s*$/gm,
      ""
    );
    transformedCode = transformedCode.replace(
      /^import\s+\{[^}]*\}\s*from\s*["']react["'];?\s*$/gm,
      ""
    );
    transformedCode = transformedCode.replace(
      /^import\s+(?:\*\s+as\s+)?React\s+from\s*["']react["'];?\s*$/gm,
      ""
    );
    // Match elysion/client and @scope/elysion/client (scoped packages)
    transformedCode = transformedCode.replace(
      /^import\s+\{[^}]*\}\s*from\s*["'](?:@[\w-]+\/)?elysion\/client["'];?\s*$/gm,
      ""
    );
    // Match elysia and @scope/elysia (scoped packages)
    transformedCode = transformedCode.replace(
      /^import\s+(?:\*\s+as\s+\w+\s*,?\s*)?(?:\{[^}]*\})?\s*from\s*["'](?:@[\w-]+\/)?elysia["'];?\s*$/gm,
      ""
    );
    transformedCode = transformedCode.replace(/^import\s+["'][^"']+\.css["'];?\s*$/gm, "");

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
