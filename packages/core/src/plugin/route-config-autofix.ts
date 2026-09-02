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

function routeConfigError(filePath: string, message: string): Error {
  return new Error(`[furin] ${filePath}: ${message}`);
}

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
  const isLayoutFile = stem === join(directory, "_route");

  let current = directory;
  while (current.startsWith(pages) && current !== pages) {
    if (!(isLayoutFile && current === directory)) {
      for (const candidate of ["_route.tsx", "_route.ts", "_route.jsx", "_route.js"]) {
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

function belongsToBuilderChain(node: unknown, bindings: BuilderBindings): boolean {
  const expression = asAstNode(node);
  if (expression?.type !== "CallExpression") {
    return false;
  }
  const callee = asAstNode(expression.callee);
  if (callee?.type === "Identifier" && typeof callee.name === "string") {
    return bindings.rootBindings.has(callee.name) || bindings.routeBindings.has(callee.name);
  }
  if (callee?.type !== "MemberExpression") {
    return false;
  }
  return belongsToBuilderChain(callee.object, bindings);
}

function collectConfigObjects(program: Program, bindings: BuilderBindings): AstNode[] {
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
      if (!belongsToBuilderChain(callee.object, bindings)) {
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

function builderChainHasMethod(
  program: Program,
  bindings: BuilderBindings,
  methodName: string
): boolean {
  let found = false;
  walk(program as never, {
    CallExpression(call) {
      const callee = asAstNode(call.callee);
      if (callee?.type !== "MemberExpression") {
        return;
      }
      const property = asAstNode(callee.property);
      if (
        property?.type === "Identifier" &&
        property.name === methodName &&
        belongsToBuilderChain(callee.object, bindings)
      ) {
        found = true;
      }
    },
  });
  return found;
}

interface BuilderBindings {
  rootBindings: Set<string>;
  routeBindings: Set<string>;
  routeSpecifiers: Map<string, { end: number; start: number }>;
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
      if (typeof specifier.start === "number" && typeof specifier.end === "number") {
        bindings.routeSpecifiers.set(local.name, {
          end: specifier.end,
          start: specifier.start,
        });
      }
    }
    if (imported.name === "defineRootRoute") {
      bindings.rootBindings.add(local.name);
    }
  }
}

function collectBuilderBindings(program: Program): BuilderBindings {
  const bindings: BuilderBindings = {
    rootBindings: new Set(),
    routeBindings: new Set(),
    routeSpecifiers: new Map(),
  };
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") {
      collectBindingsFromDeclaration(statement as unknown as ImportDeclaration, bindings);
    }
  }
  return bindings;
}

interface ChainHead {
  binding: string;
  builderEnd: number;
  end: number;
  exportedAsRoute: boolean;
  isRoot: boolean;
  start: number;
  terminal: string | null;
}

function terminalName(node: unknown): string | null {
  const expression = asAstNode(node);
  if (expression?.type !== "CallExpression") {
    return null;
  }
  const callee = asAstNode(expression.callee);
  if (callee?.type !== "MemberExpression") {
    return null;
  }
  const property = asAstNode(callee.property);
  return property?.type === "Identifier" && typeof property.name === "string"
    ? property.name
    : null;
}

/** `defineRoute()` / `defineRootRoute()` calls and their observable chain terminal. */
function collectChainHeads(program: Program, bindings: BuilderBindings): ChainHead[] {
  const heads: ChainHead[] = [];
  walk(program as never, {
    CallExpression(call, context) {
      const callee = asAstNode(call.callee);
      if (callee?.type !== "Identifier" || typeof callee.name !== "string") {
        return;
      }
      const callEnd = typeof call.end === "number" ? call.end : 0;
      const calleeStart = typeof callee.start === "number" ? callee.start : 0;
      const calleeEnd = typeof callee.end === "number" ? callee.end : 0;
      const ancestors = context.ancestors() as AstNode[];
      const declaration = ancestors.find((ancestor) => ancestor.type === "VariableDeclarator");
      const identifier = asAstNode(declaration?.id);
      const variableDeclaration = ancestors.find(
        (ancestor) => ancestor.type === "VariableDeclaration"
      );
      const exportedAsRoute =
        identifier?.type === "Identifier" &&
        identifier.name === "route" &&
        variableDeclaration?.kind === "const" &&
        ancestors.some((ancestor) => ancestor.type === "ExportNamedDeclaration");
      const terminal = terminalName(declaration?.init);
      if (bindings.rootBindings.has(callee.name)) {
        heads.push({
          binding: callee.name,
          builderEnd: calleeEnd,
          end: callEnd,
          exportedAsRoute,
          isRoot: true,
          start: calleeStart,
          terminal,
        });
        return;
      }
      if (bindings.routeBindings.has(callee.name)) {
        heads.push({
          binding: callee.name,
          builderEnd: calleeEnd,
          end: callEnd,
          exportedAsRoute,
          isRoot: false,
          start: calleeStart,
          terminal,
        });
      }
    },
  });
  return heads;
}

interface FixContext {
  expected: ExpectedLayout | null;
  expectedResolvedPath: string;
  filePath: string;
  hasLoader: boolean;
  imports: LayoutImport[];
  isRootLayout: boolean;
  lastImportEnd: number;
  magic: MagicString;
  source: string;
}

type InferredRenderingMode = "isr" | "ssg" | "ssr";

function inferRenderingMode({
  hasLoader,
  hasQuery,
  hasRevalidate,
  isRootLayout,
}: {
  hasLoader: boolean;
  hasQuery: boolean;
  hasRevalidate: boolean;
  isRootLayout: boolean;
}): InferredRenderingMode {
  if (isRootLayout || hasQuery) {
    return "ssr";
  }
  if (!hasLoader) {
    return "ssg";
  }
  return hasRevalidate ? "isr" : "ssr";
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
    `\nimport { route as ${binding} } from "${expected.importPath}";${
      ctx.source[insertionOffset] === "\n" || ctx.source[insertionOffset] === "\r" ? "" : "\n"
    }`
  );
  ctx.imports.push({ binding, resolvedPath: ctx.expectedResolvedPath });
  return binding;
}

function removeObjectProperties(
  object: AstNode,
  properties: AstNode[],
  removed: Set<AstNode>,
  magic: MagicString
): void {
  if (removed.size === 0) {
    return;
  }
  if (
    removed.size === properties.length &&
    typeof object.start === "number" &&
    typeof object.end === "number"
  ) {
    magic.remove(object.start + 1, object.end - 1);
    return;
  }

  let firstRemovedIndex: number | null = null;
  for (let index = 0; index <= properties.length; index += 1) {
    const property = properties[index];
    if (property && removed.has(property)) {
      firstRemovedIndex ??= index;
      continue;
    }
    if (firstRemovedIndex === null) {
      continue;
    }
    const first = properties[firstRemovedIndex];
    const last = properties[index - 1];
    const previous = properties[firstRemovedIndex - 1];
    if (!(first && last && typeof first.start === "number" && typeof last.end === "number")) {
      firstRemovedIndex = null;
      continue;
    }
    if (property && typeof property.start === "number") {
      magic.remove(first.start, property.start);
    } else if (previous && typeof previous.end === "number") {
      magic.remove(previous.end, last.end);
    } else {
      magic.remove(first.start, last.end);
    }
    firstRemovedIndex = null;
  }
}

interface ConfigProperties {
  all: AstNode[];
  layout: AstNode | undefined;
  mode: AstNode | undefined;
  query: AstNode | undefined;
  revalidate: AstNode | undefined;
  staticParams: AstNode | undefined;
}

function collectConfigProperties(object: AstNode): ConfigProperties {
  const propertyValues: unknown[] = Array.isArray(object.properties) ? object.properties : [];
  const all = propertyValues
    .map((property) => asAstNode(property))
    .filter((property): property is AstNode => property !== null);
  const findProperty = (name: string) =>
    all.find((property) => property.type === "Property" && propertyName(property.key) === name);
  return {
    all,
    layout: findProperty("layout"),
    mode: findProperty("mode"),
    query: findProperty("query"),
    revalidate: findProperty("revalidate"),
    staticParams: findProperty("staticParams"),
  };
}

function validateConfigProperties(
  properties: ConfigProperties,
  ctx: FixContext
): { inferredMode: InferredRenderingMode | null; layoutValue: AstNode | null } {
  const layoutValue = properties.layout ? asAstNode(properties.layout.value) : null;
  if (!ctx.isRootLayout && properties.layout && layoutValue?.type !== "Identifier") {
    throw routeConfigError(ctx.filePath, "use a static layout route reference");
  }
  const modeValue = properties.mode ? asAstNode(properties.mode.value) : null;
  if (
    properties.revalidate &&
    modeValue?.type === "Literal" &&
    (modeValue.value === "ssg" || modeValue.value === "ssr")
  ) {
    throw routeConfigError(ctx.filePath, "revalidate requires mode isr");
  }
  if (properties.staticParams && modeValue?.type === "Literal" && modeValue.value === "ssr") {
    throw routeConfigError(ctx.filePath, "staticParams requires mode ssg or isr");
  }
  if (!properties.revalidate && modeValue?.type === "Literal" && modeValue.value === "isr") {
    throw routeConfigError(ctx.filePath, "isr requires revalidate > 0 (or use ssg/ssr)");
  }

  const inferredMode = properties.mode
    ? null
    : inferRenderingMode({
        hasLoader: ctx.hasLoader,
        hasQuery: Boolean(properties.query),
        hasRevalidate: Boolean(properties.revalidate),
        isRootLayout: ctx.isRootLayout,
      });
  if (properties.staticParams && inferredMode === "ssr") {
    throw routeConfigError(ctx.filePath, "staticParams requires mode ssg or isr");
  }
  return { inferredMode, layoutValue };
}

function removeInvalidConfigProperties(
  object: AstNode,
  properties: ConfigProperties,
  inferredMode: InferredRenderingMode | null,
  ctx: FixContext
): Set<AstNode> {
  const removed = new Set<AstNode>();
  if (ctx.isRootLayout && properties.layout) {
    removed.add(properties.layout);
  }
  if (properties.revalidate && inferredMode !== null && inferredMode !== "isr") {
    removed.add(properties.revalidate);
  }
  removeObjectProperties(object, properties.all, removed, ctx.magic);
  return removed;
}

function repointLayout(layoutValue: AstNode | null, ctx: FixContext): boolean {
  if (layoutValue?.type === "Identifier" && ctx.expected) {
    const binding = resolveBinding(ctx, Math.max(ctx.lastImportEnd, 0));
    if (
      binding !== layoutValue.name &&
      typeof layoutValue.start === "number" &&
      typeof layoutValue.end === "number"
    ) {
      ctx.magic.update(layoutValue.start, layoutValue.end, binding);
      return true;
    }
  }
  return false;
}

function missingConfigEntries(
  properties: ConfigProperties,
  inferredMode: InferredRenderingMode | null,
  ctx: FixContext
): string[] {
  const missing: string[] = [];
  if (!(properties.layout || ctx.isRootLayout) && ctx.expected) {
    const binding = resolveBinding(ctx, Math.max(ctx.lastImportEnd, 0));
    missing.push(`layout: ${binding}`);
  }
  if (!properties.mode) {
    missing.push(`mode: "${inferredMode}"`);
  }
  return missing;
}

function insertConfigEntries(
  object: AstNode,
  entries: string[],
  properties: ConfigProperties,
  removed: Set<AstNode>,
  ctx: FixContext
): boolean {
  if (entries.length === 0) {
    return false;
  }
  const first = properties.all.find(
    (property) => !removed.has(property) && typeof property.start === "number"
  );
  if (first && typeof first.start === "number") {
    ctx.magic.appendRight(first.start, `${entries.join(", ")}, `);
    return true;
  }
  if (typeof object.start === "number") {
    ctx.magic.appendRight(object.start + 1, ` ${entries.join(", ")} `);
    return true;
  }
  return false;
}

function injectMissingConfigKeys(object: AstNode, ctx: FixContext): boolean {
  const properties = collectConfigProperties(object);
  const { inferredMode, layoutValue } = validateConfigProperties(properties, ctx);
  const removed = removeInvalidConfigProperties(object, properties, inferredMode, ctx);
  const layoutRepointed = repointLayout(layoutValue, ctx);
  const missing = missingConfigEntries(properties, inferredMode, ctx);
  const entriesInserted = insertConfigEntries(object, missing, properties, removed, ctx);
  return removed.size > 0 || layoutRepointed || entriesInserted;
}

interface RouteFileConvention {
  expected: ExpectedLayout | null;
  fileName: string | undefined;
  filePath: string;
  isNestedLayout: boolean;
  isRootLayout: boolean;
}

function routeFileConvention(
  filePath: string,
  pagesDir: string,
  probe: LayoutProbe
): RouteFileConvention {
  const pages = resolve(pagesDir);
  const file = resolve(filePath);
  const extensionlessFile = withoutExtension(file);
  return {
    expected: expectedLayoutFor(filePath, pagesDir, probe),
    fileName: extensionlessFile.split(DIRECTORY_SPLIT_RE).pop(),
    filePath,
    isNestedLayout: extensionlessFile === join(resolve(file, ".."), "_route"),
    isRootLayout: extensionlessFile === join(pages, "root"),
  };
}

function scaffoldEmptyRoute(convention: RouteFileConvention): string | null {
  const { expected, fileName, filePath, isNestedLayout, isRootLayout } = convention;
  if (isRootLayout) {
    return `import { defineRootRoute } from "@teyik0/furin";

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => children);
`;
  }
  if (isNestedLayout && expected) {
    return `import { defineRoute } from "@teyik0/furin";
import { route as ${expected.identifier} } from "${expected.importPath}";

export const route = defineRoute()
  .config({ layout: ${expected.identifier}, mode: "ssr" })
  .layout(({ children }) => children);
`;
  }
  if (fileName === "error" || fileName === "not-found") {
    return null;
  }
  if (!expected) {
    throw routeConfigError(filePath, "no ancestor layout found; create pages/root.tsx");
  }
  return `import { defineRoute } from "@teyik0/furin";
import { route as ${expected.identifier} } from "${expected.importPath}";

export const route = defineRoute()
  .config({ layout: ${expected.identifier}, mode: "ssg" })
  .page(() => null);
`;
}

function validateRouteChain(heads: ChainHead[], convention: RouteFileConvention): ChainHead | null {
  if (heads.length === 0) {
    return null;
  }
  if (heads.length > 1) {
    throw routeConfigError(convention.filePath, "one route per file");
  }
  const [routeHead] = heads;
  if (!routeHead) {
    return null;
  }
  if (!convention.isRootLayout && routeHead.isRoot) {
    throw routeConfigError(
      convention.filePath,
      "use defineRoute + config({ layout }) outside pages/root.tsx"
    );
  }
  if (!(convention.isRootLayout || convention.expected)) {
    throw routeConfigError(convention.filePath, "no ancestor layout found; create pages/root.tsx");
  }
  if (convention.isNestedLayout && routeHead.terminal === "page") {
    throw routeConfigError(convention.filePath, "_route files must end with .layout()");
  }
  if (!(convention.isRootLayout || convention.isNestedLayout) && routeHead.terminal === "layout") {
    throw routeConfigError(convention.filePath, "page files must end with .page()");
  }
  if (!routeHead.exportedAsRoute) {
    throw routeConfigError(
      convention.filePath,
      "route files must export a route terminal as export const route"
    );
  }
  return routeHead;
}

function rewriteRootBuilder(
  routeHead: ChainHead,
  bindings: BuilderBindings,
  isRootLayout: boolean,
  magic: MagicString
): boolean {
  if (!(isRootLayout && !routeHead.isRoot)) {
    return false;
  }
  const existingRootBinding = bindings.rootBindings.values().next().value as string | undefined;
  const replacement = existingRootBinding ?? "defineRootRoute";
  if (!existingRootBinding) {
    const specifier = bindings.routeSpecifiers.get(routeHead.binding);
    if (specifier) {
      magic.update(specifier.start, specifier.end, "defineRootRoute");
    }
  }
  magic.update(routeHead.start, routeHead.builderEnd, replacement);
  return true;
}

function insertCompleteConfig(routeHead: ChainHead, ctx: FixContext): string {
  const binding =
    ctx.expected && !ctx.isRootLayout ? resolveBinding(ctx, Math.max(ctx.lastImportEnd, 0)) : null;
  const layoutPart = binding && !ctx.isRootLayout ? `layout: ${binding}, ` : "";
  const mode = inferRenderingMode({
    hasLoader: ctx.hasLoader,
    hasQuery: false,
    hasRevalidate: false,
    isRootLayout: ctx.isRootLayout,
  });
  ctx.magic.appendRight(routeHead.end, `.config({ ${layoutPart}mode: "${mode}" })`);
  return ctx.magic.toString();
}

/**
 * Rewrites `defineRoute()` chains so every route file declares a full
 * `config({ layout, mode, ... })`:
 *   - chain without `config()`       → inserts `.config({ layout, mode })`
 *   - `config()` without `layout`    → injects the expected ancestor layout
 *   - `config()` with a WRONG layout → repoints the reference (and its import)
 *   - `config()` without `mode`      → infers the mode using the runtime cascade
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
  const convention = routeFileConvention(filePath, pagesDir, probe);
  if (source.trim().length === 0) {
    return scaffoldEmptyRoute(convention);
  }
  if (!(source.includes("defineRoute") || source.includes("defineRootRoute"))) {
    return null;
  }
  const parsed = parseSource(source, detectLangFromPath(filePath));
  const magic = new MagicString(source);
  const expectedResolvedPath = convention.expected
    ? withoutExtension(resolve(filePath, "..", convention.expected.importPath))
    : "";
  const { imports, lastImportEnd } = collectLayoutImports(parsed.program, filePath);
  const bindings = collectBuilderBindings(parsed.program);
  const hasLoader = builderChainHasMethod(parsed.program, bindings, "loader");
  const heads = collectChainHeads(parsed.program, bindings).filter(
    (candidate) => candidate.end !== 0
  );
  const routeHead = validateRouteChain(heads, convention);
  if (!routeHead) {
    return null;
  }
  let touched = rewriteRootBuilder(routeHead, bindings, convention.isRootLayout, magic);
  const configObjects = collectConfigObjects(parsed.program, bindings);
  const ctx: FixContext = {
    expected: convention.expected,
    expectedResolvedPath,
    filePath,
    hasLoader,
    imports,
    isRootLayout: convention.isRootLayout,
    lastImportEnd,
    magic,
    source,
  };
  if (configObjects.length === 0) {
    return insertCompleteConfig(routeHead, ctx);
  }
  for (const object of configObjects) {
    touched = injectMissingConfigKeys(object, ctx) || touched;
  }

  const output = magic.toString();
  // Structural idempotence: a rewrite that produces the exact input is no
  // change at all (protects every future branch from breaking the contract).
  return output === source ? null : output;
}
