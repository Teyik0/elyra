import { existsSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import MagicString from "magic-string";
import { walk } from "yuku-ast";
import type { ImportDeclaration, Program } from "yuku-parser";
import { detectLangFromPath, unwrapTSExpression } from "../server/lang-detect.ts";
import { parseSource } from "../shared/parser.ts";
import type { AstNode } from "../shared/utils/ast-walk.ts";

/**
 * Dev-time auto-fix for `config({ layout })`, mirroring how TanStack Router's
 * generator rewrites `createFileRoute` ids: the watcher scans route files,
 * computes the expected ancestor layout from the file system, and rewrites
 * the config object (plus the import) when the declared reference is missing
 * or points at the wrong module. Content edits never retrigger the watcher,
 * so the rewrite cannot loop; the dev renderer re-reads the file on the next
 * request through its cache-busting import.
 */

const DIRECTORY_SPLIT_RE = /[\\/]/;
const NON_ALPHANUMERIC_RE = /[^a-zA-Z0-9]/g;

export interface ExpectedLayout {
  /** Preferred local binding, e.g. "rootRoute". */
  identifier: string;
  /** Import specifier relative from the route file, e.g. "../root". */
  importPath: string;
}

export type LayoutProbe = (path: string) => boolean;

function asAstNode(node: unknown): AstNode | null {
  if (!node || typeof node !== "object" || !("type" in node)) {
    return null;
  }
  return unwrapTSExpression(node as { type: string }) as AstNode;
}

function propertyName(node: unknown): string | null {
  const ast = asAstNode(node);
  if (ast?.type !== "Identifier" || typeof ast.name !== "string") {
    return null;
  }
  return ast.name;
}

const WITHOUT_EXTENSION_RE = /\.(ts|tsx|jsx|js|mts|cts)$/;

function withoutExtension(path: string): string {
  return path.replace(WITHOUT_EXTENSION_RE, "");
}

function toImportSpecifier(fromFile: string, toFile: string): string {
  const specifier = withoutExtension(relative(resolve(fromFile, ".."), toFile)).replaceAll(
    "\\",
    "/"
  );
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

/** Deterministic binding for a layout file: `root.tsx` → `rootRoute`, `board/_route.tsx` → `boardRoute`. */
export function layoutIdentifierFor(layoutPath: string): string {
  const extension = extname(layoutPath);
  const stem = layoutPath.slice(0, layoutPath.length - extension.length);
  const base = stem.split(DIRECTORY_SPLIT_RE).pop() ?? "";
  const source =
    base === "_route" ? (resolve(layoutPath, "..").split(DIRECTORY_SPLIT_RE).pop() ?? "") : base;
  const name = (source || "root").replace(NON_ALPHANUMERIC_RE, "");
  return `${name || "root"}Route`;
}

/**
 * The layout a route file should reference: the nearest `_route.ts(x)` walking
 * up from its own directory (a `_route` file looks at its PARENT directory),
 * falling back to the `root.tsx` convention at the pages root. Returns null
 * for the root layout itself — nothing above it exists.
 */
export function expectedLayoutFor(
  filePath: string,
  pagesDir: string,
  probe: LayoutProbe = existsSync
): ExpectedLayout | null {
  const pages = resolve(pagesDir);
  const file = resolve(filePath);
  const directory = resolve(file, "..");
  const extension = extname(file);
  const stem = file.slice(0, file.length - extension.length);
  if (stem === join(pages, "root")) {
    return null; // the root layout references nothing above it
  }
  const isLayoutFile = stem.endsWith("_route");

  let current = directory;
  while (current.startsWith(pages) && current !== pages) {
    if (!(isLayoutFile && current === directory)) {
      for (const candidate of ["_route.tsx", "_route.ts"]) {
        const layoutPath = join(current, candidate);
        if (probe(layoutPath)) {
          return {
            identifier: layoutIdentifierFor(layoutPath),
            importPath: toImportSpecifier(file, layoutPath),
          };
        }
      }
    }
    current = resolve(current, "..");
  }

  for (const candidate of ["root.tsx", "root.ts"]) {
    const layoutPath = join(pages, candidate);
    if (probe(layoutPath)) {
      return {
        identifier: layoutIdentifierFor(layoutPath),
        importPath: toImportSpecifier(file, layoutPath),
      };
    }
  }
  return null;
}

interface LayoutImport {
  binding: string;
  resolvedPath: string;
}

interface CollectedImports {
  imports: LayoutImport[];
  /** End offset of the last import statement (import insertion point). */
  lastImportEnd: number;
}

function collectLayoutImports(program: Program, filePath: string): CollectedImports {
  const imports: LayoutImport[] = [];
  let lastImportEnd = 0;
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    const declaration = statement as unknown as ImportDeclaration;
    if (declaration.importKind === "type") {
      continue;
    }
    const end = typeof declaration.end === "number" ? declaration.end : 0;
    if (end > lastImportEnd) {
      lastImportEnd = end;
    }
    const specifierValue = declaration.source?.value;
    if (typeof specifierValue !== "string") {
      continue;
    }
    const resolvedPath = withoutExtension(resolve(filePath, "..", specifierValue));
    for (const specifier of declaration.specifiers as unknown as AstNode[]) {
      if (specifier.type !== "ImportSpecifier") {
        continue;
      }
      const imported = asAstNode(specifier.imported);
      const local = asAstNode(specifier.local);
      if (
        imported?.type === "Identifier" &&
        typeof imported.name === "string" &&
        imported.name === "route" &&
        local?.type === "Identifier" &&
        typeof local.name === "string"
      ) {
        imports.push({ binding: local.name, resolvedPath });
      }
    }
  }
  return { imports, lastImportEnd };
}

function collectConfigObjects(program: Program): AstNode[] {
  const objects: AstNode[] = [];
  walk(program as never, {
    CallExpression(call) {
      const callee = asAstNode(call.callee);
      if (callee?.type !== "MemberExpression" || typeof callee.property !== "object") {
        return;
      }
      const property = asAstNode(callee.property);
      if (property?.type !== "Identifier" || property.name !== "config") {
        return;
      }
      const argument = Array.isArray(call.arguments) ? asAstNode(call.arguments[0]) : null;
      if (argument?.type === "ObjectExpression") {
        objects.push(argument);
      }
    },
  });
  return objects;
}

interface BuilderBindings {
  rootBindings: Set<string>;
  routeBindings: Set<string>;
}

const FURIN_BUILDER_MODULES = new Set([
  "@teyik0/furin",
  "furin",
  "@teyik0/furin/client",
  "furin/client",
]);

function collectBindingsFromDeclaration(
  declaration: ImportDeclaration,
  bindings: BuilderBindings
): void {
  const specifierValue = declaration.source?.value;
  if (typeof specifierValue !== "string" || !FURIN_BUILDER_MODULES.has(specifierValue)) {
    return;
  }
  for (const specifier of declaration.specifiers as unknown as AstNode[]) {
    if (specifier.type !== "ImportSpecifier") {
      continue;
    }
    const imported = asAstNode(specifier.imported);
    const local = asAstNode(specifier.local);
    if (imported?.type !== "Identifier" || typeof imported.name !== "string") {
      continue;
    }
    if (local?.type !== "Identifier" || typeof local.name !== "string") {
      continue;
    }
    if (imported.name === "defineRoute") {
      bindings.routeBindings.add(local.name);
    }
    if (imported.name === "defineRootRoute") {
      bindings.rootBindings.add(local.name);
    }
  }
}

function collectBuilderBindings(program: Program): BuilderBindings {
  const bindings: BuilderBindings = { rootBindings: new Set(), routeBindings: new Set() };
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") {
      collectBindingsFromDeclaration(statement as unknown as ImportDeclaration, bindings);
    }
  }
  return bindings;
}

/** First `defineRoute()` / `defineRootRoute()` call — the chain head. */
function collectChainHeads(
  program: Program,
  bindings: BuilderBindings
): { end: number; isRoot: boolean }[] {
  const heads: { end: number; isRoot: boolean }[] = [];
  walk(program as never, {
    CallExpression(call) {
      const callee = asAstNode(call.callee);
      if (callee?.type !== "Identifier" || typeof callee.name !== "string") {
        return;
      }
      const callEnd = typeof call.end === "number" ? call.end : 0;
      if (bindings.rootBindings.has(callee.name)) {
        heads.push({ end: callEnd, isRoot: true });
        return;
      }
      if (bindings.routeBindings.has(callee.name)) {
        heads.push({ end: callEnd, isRoot: false });
      }
    },
  });
  return heads;
}

interface FixContext {
  expected: ExpectedLayout | null;
  expectedResolvedPath: string;
  filePath: string;
  imports: LayoutImport[];
  isRootLayout: boolean;
  lastImportEnd: number;
  magic: MagicString;
  source: string;
}

const wordBoundaryRe = (binding: string): RegExp => new RegExp(`\\b${binding}\\b`);

function resolveBinding(ctx: FixContext, insertionOffset: number): string {
  const existing = ctx.imports.find(
    (candidate) => candidate.resolvedPath === ctx.expectedResolvedPath
  );
  if (existing) {
    return existing.binding;
  }
  const expected = ctx.expected as ExpectedLayout;
  const taken = new Set(ctx.imports.map((candidate) => candidate.binding));
  let binding = expected.identifier;
  let suffix = 2;
  while (taken.has(binding) || wordBoundaryRe(binding).test(ctx.source)) {
    binding = `${expected.identifier}${suffix}`;
    suffix += 1;
  }
  ctx.magic.appendRight(
    insertionOffset,
    `\nimport { route as ${binding} } from "${expected.importPath}";\n`
  );
  ctx.imports.push({ binding, resolvedPath: ctx.expectedResolvedPath });
  return binding;
}

function injectMissingConfigKeys(object: AstNode, ctx: FixContext): boolean {
  const properties = (object.properties ?? []) as unknown[];
  const findProperty = (name: string) =>
    properties
      .map((property) => asAstNode(property))
      .find((property) => property?.type === "Property" && propertyName(property.key) === name);

  const layoutProperty = findProperty("layout");
  const modeProperty = findProperty("mode");
  const value = layoutProperty ? asAstNode(layoutProperty.value) : null;
  const declared =
    value?.type === "Identifier" && typeof value.name === "string"
      ? ctx.imports.find((candidate) => candidate.binding === value.name)
      : undefined;

  const first = properties
    .map((property) => asAstNode(property))
    .find((property) => property && typeof property.start === "number");
  if (!first || typeof first.start !== "number") {
    return false;
  }

  const missing: string[] = [];
  if (!(layoutProperty || ctx.isRootLayout) && ctx.expected) {
    const binding = resolveBinding(ctx, Math.max(ctx.lastImportEnd, 0));
    missing.push(`layout: ${binding}`);
  }
  if (!modeProperty) {
    missing.push('mode: "ssr"');
  }
  if (missing.length > 0) {
    ctx.magic.appendRight(first.start, `${missing.join(", ")}, `);
    return true;
  }
  // Layout present but misreferenced — repoint it at the expected module.
  if (value && value.type === "Identifier" && declared) {
    const binding = resolveBinding(ctx, Math.max(ctx.lastImportEnd, 0));
    ctx.magic.update(value.start as number, value.end as number, binding);
    return true;
  }
  return false;
}

/**
 * Rewrites `defineRoute()` chains so every route file declares a full
 * `config({ layout, mode, ... })`:
 *   - chain without `config()`       → inserts `.config({ layout, mode })`
 *   - `config()` without `layout`    → injects the expected ancestor layout
 *   - `config()` with a WRONG layout → repoints the reference (and its import)
 *   - `config()` without `mode`      → injects `mode: "ssr"` (historical default)
 * The root layout (`pages/root.tsx`, built with `defineRootRoute()`) never
 * receives a `layout`. Returns the new source, or null when unchanged
 * (idempotent — running the fix twice returns null on the second pass).
 */
export function fixRouteConfigLayout(
  source: string,
  filePath: string,
  pagesDir: string,
  probe: LayoutProbe = existsSync
): string | null {
  if (!(source.includes("defineRoute") || source.includes("defineRootRoute"))) {
    return null;
  }
  const pages = resolve(pagesDir);
  const file = resolve(filePath);
  const isRootLayout = withoutExtension(file) === join(pages, "root");
  const expected = expectedLayoutFor(filePath, pagesDir, probe);
  if (!(isRootLayout || expected)) {
    return null; // no ancestor to reference — nothing sensible to inject
  }
  const parsed = parseSource(source, detectLangFromPath(filePath));
  const magic = new MagicString(source);
  const expectedResolvedPath = expected
    ? withoutExtension(resolve(filePath, "..", expected.importPath))
    : "";
  const { imports, lastImportEnd } = collectLayoutImports(parsed.program, filePath);
  const bindings = collectBuilderBindings(parsed.program);

  let touched = false;
  const configObjects = collectConfigObjects(parsed.program);

  if (configObjects.length === 0) {
    // Chain without any config — insert the full required config.
    const [head] = collectChainHeads(parsed.program, bindings);
    if (!head || head.end === 0) {
      return null;
    }
    const binding =
      expected && !isRootLayout
        ? resolveBinding(
            {
              expected,
              expectedResolvedPath,
              filePath,
              imports,
              isRootLayout,
              lastImportEnd,
              magic,
              source,
            },
            Math.max(lastImportEnd, 0)
          )
        : null;
    const layoutPart = binding && !isRootLayout ? `layout: ${binding}, ` : "";
    magic.appendRight(head.end, `.config({ ${layoutPart}mode: "ssr" })`);
    return magic.toString();
  }

  const ctx: FixContext = {
    expected,
    expectedResolvedPath,
    filePath,
    imports,
    isRootLayout,
    lastImportEnd,
    magic,
    source,
  };
  for (const object of configObjects) {
    touched = injectMissingConfigKeys(object, ctx) || touched;
  }

  const output = magic.toString();
  // Structural idempotence: a rewrite that produces the exact input is no
  // change at all (protects every future branch from breaking the contract).
  return output === source ? null : output;
}
