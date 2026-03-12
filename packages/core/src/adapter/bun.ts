import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildClient } from "../build/client";
import { generateCompileEntry } from "../build/compile-entry";
import { buildTargetManifest, ensureDir, toPosixPath, writeJsonFile } from "../build/shared";
import type { BuildAppOptions, TargetBuildManifest } from "../build/types";
import type { BuildTarget } from "../config";
import type { ResolvedRoute } from "../router";

async function compileBinary(entrypoint: string, outfile: string, label: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    compile: { outfile },
    minify: true,
    sourcemap: "linked",
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error(`[elyra] Server compile failed (${label})`);
  }
  console.log(`[elyra] Server binary (${label}): ${outfile}`);
}

export async function buildBunTarget(
  routes: ResolvedRoute[],
  rootDir: string,
  buildRoot: string,
  rootPath: string,
  serverEntry: string | null,
  options: BuildAppOptions
): Promise<TargetBuildManifest> {
  if (options.compile && !serverEntry) {
    throw new Error(
      `[elyra] \`compile: "${options.compile}"\` requires a server entry point. ` +
        "Create src/server.ts or set `serverEntry` in your elyra.config.ts."
    );
  }

  const target = "bun" satisfies BuildTarget;
  const targetManifest = buildTargetManifest(rootDir, buildRoot, target, serverEntry);
  const targetDir = resolve(rootDir, targetManifest.targetDir);

  rmSync(targetDir, { force: true, recursive: true });
  ensureDir(targetDir);

  await buildClient(routes, {
    outDir: targetDir,
    rootLayout: rootPath,
    minify: options.minify,
    sourcemap: options.sourcemap,
    plugins: options.plugins,
  });

  if (options.compile && serverEntry) {
    const outfile = join(targetDir, "server");
    const entryPath = generateCompileEntry({
      rootPath,
      pagePaths: routes.map((r) => r.path),
      serverEntry,
      outDir: targetDir,
      embed: options.compile === "embed" ? { clientDir: join(targetDir, "client") } : undefined,
    });

    console.log(`[elyra] Compiling server binary (${options.compile} mode)…`);
    await compileBinary(entryPath, outfile, options.compile);
    targetManifest.serverPath = toPosixPath(join(targetManifest.targetDir, "server"));
  }

  writeJsonFile(resolve(rootDir, targetManifest.manifestPath), targetManifest);
  return targetManifest;
}
