import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { t } from "elysia";
import { TypeCompiler } from "elysia/type-system";
import { BUILD_TARGETS, type BuildTarget, type ElyraConfig } from "../config";

const buildTargetSchema = t.Union(BUILD_TARGETS.map((v) => t.Literal(v)));

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
      compile: t.Optional(t.Boolean()),
    })
  ),
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
  const config: ElyraConfig = imported.default ?? imported;

  if (!compiledConfigSchema.Check(config)) {
    const [firstError] = compiledConfigSchema.Errors(config);
    throw new Error(
      `[elyra] Invalid config at ${configPath}: ${firstError?.message ?? "unknown error"} (path: ${firstError?.path ?? "/"})`
    );
  }

  const resolvedRootDir = resolve(rootDir, config.rootDir ?? ".");
  return {
    ...config,
    configPath,
    rootDir: resolvedRootDir,
    pagesDir: resolve(resolvedRootDir, config.pagesDir ?? "src/pages"),
  };
}
