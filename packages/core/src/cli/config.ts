import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { t } from "elysia";
import { TypeCompiler } from "elysia/type-system";
import { BUILD_TARGETS, type BuildTarget, type ElyraConfig } from "../config";

const buildTargetSchema = t.Union(BUILD_TARGETS.map((v) => t.Literal(v)));
const compileTargetSchema = t.Union([t.Literal("split"), t.Literal("embed")]);

const configSchema = t.Object({
  rootDir: t.Optional(t.String()),
  pagesDir: t.Optional(t.String()),
  outDir: t.Optional(t.String()),
  serverEntry: t.Optional(t.String()),
  targets: t.Optional(t.Array(buildTargetSchema)),
  client: t.Optional(
    t.Object({
      minify: t.Optional(t.Boolean()),
      sourcemap: t.Optional(t.Boolean()),
    })
  ),
  bun: t.Optional(
    t.Object({
      compile: t.Optional(compileTargetSchema),
    })
  ),
  // plugins is intentionally omitted: TypeBox cannot validate Bun.BunPlugin[]
  // (functions are not JSON-serializable). We extract it before validation.
});

const compiledConfigSchema = TypeCompiler.Compile(configSchema);

const DEFAULT_CONFIG_FILENAMES = [
  "elyra.config.ts",
  "elyra.config.js",
  "elyra.config.mjs",
] as const;

interface ResolvedCliConfig extends ElyraConfig {
  configPath: string | null;
  pagesDir: string;
  plugins?: Bun.BunPlugin[];
  rootDir: string;
}

export function resolveServerEntrypoint(rootDir: string, target?: BuildTarget): string | null {
  const candidates = [
    target ? `src/server.${target}.ts` : undefined,
    "src/server.ts",
    "src/app.ts",
  ].filter((value): value is string => !!value);

  for (const candidate of candidates) {
    const path = resolve(rootDir, candidate);
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

export async function loadCliConfig(
  cwd: string,
  explicitConfigPath?: string
): Promise<ResolvedCliConfig> {
  const rootDir = resolve(cwd);
  const configPath = explicitConfigPath
    ? resolve(rootDir, explicitConfigPath)
    : DEFAULT_CONFIG_FILENAMES.map((filename) => resolve(rootDir, filename)).find((path) =>
        existsSync(path)
      );

  if (!configPath) {
    return {
      configPath: null,
      rootDir,
      pagesDir: resolve(rootDir, "src/pages"),
    };
  }

  const imported = await import(pathToFileURL(configPath).href);
  const rawConfig: ElyraConfig = imported.default ?? imported;

  // Extract plugins before TypeBox validation: functions cannot be JSON-schema validated
  const { plugins, ...configToValidate } = rawConfig;

  if (plugins !== undefined && !Array.isArray(plugins)) {
    throw new Error(
      `[elyra] Invalid config at ${configPath}: "plugins" must be an array of BunPlugin objects`
    );
  }

  if (!compiledConfigSchema.Check(configToValidate)) {
    const [firstError] = compiledConfigSchema.Errors(configToValidate);
    throw new Error(
      `[elyra] Invalid config at ${configPath}: ${firstError?.message ?? "unknown error"} (path: ${firstError?.path ?? "/"})`
    );
  }

  const resolvedRootDir = resolve(rootDir, configToValidate.rootDir ?? ".");
  return {
    ...configToValidate,
    plugins,
    configPath,
    rootDir: resolvedRootDir,
    pagesDir: resolve(resolvedRootDir, configToValidate.pagesDir ?? "src/pages"),
  };
}
