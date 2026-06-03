import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { $ } from "bun";

$.cwd(import.meta.dir);

await $`rm -rf dist bin`;
await $`rm -f tsconfig.dts.tsbuildinfo`;
await $`bunx tsc --project tsconfig.dts.json`;

// Each entrypoint is built in its own Bun.build() call.
// Bun bug: when entrypoints share imports (furinjs → router, furinjs → build),
// Bun folds some outputs into others or omits them entirely. Building each
// entrypoint separately produces correct, self-contained bundles.
const shared = {
  outdir: `${import.meta.dir}/dist`,
  root: `${import.meta.dir}/src`,
  target: "bun" as const,
  format: "esm" as const,
  external: ["elysia", "react", "react-dom", "@elysiajs/static", "yuku-parser"],
  minify: false,
  sourcemap: false,
};

await Promise.all([
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/cli/index.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/server/furin.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/client.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/build/index.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/config.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/server/router/index.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/plugin/index.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/client/link.tsx`] }),
  // Modules imported directly by the generated compile-entry (entry-template.ts).
  // Must exist as standalone files so the dist/ fallback path works.
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/server/internal.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/server/runtime-env.ts`] }),
]);

// Copy ambient declaration so it is available for the ./env export.
await $`cp src/env.d.ts dist/env.d.ts`;

// Ensure target directories exist before copying runtime source files.
// dist/build is created by Bun.build above, but dist/server/render and
// dist/server/router are not — without this, clean builds where tsc is
// skipped would fail.
mkdirSync(`${import.meta.dir}/dist/build`, { recursive: true });
mkdirSync(`${import.meta.dir}/dist/server/render`, { recursive: true });
mkdirSync(`${import.meta.dir}/dist/server/router`, { recursive: true });

// Copy template source files that the adapter reads at runtime.
await $`cp src/build/compile-entry.ts dist/build/compile-entry.ts`;
await $`cp src/build/entry-template.ts dist/build/entry-template.ts`;
await $`cp src/build/server-routes-entry.ts dist/build/server-routes-entry.ts`;
await $`cp src/server/render/index.ts dist/server/render/index.ts`;
await $`cp src/server/render/shell.ts dist/server/render/shell.ts`;
await $`cp src/server/router/index.ts dist/server/router/index.ts`;

// Prepend shebang to CLI dist file so the OS runs it with Bun (not as a shell script).
// Guard against duplication: if the shebang is already present (e.g. build run twice),
// skip the write so we don't corrupt the file with a double shebang.
const cliPath = `${import.meta.dir}/dist/cli/index.js`;
const content = readFileSync(cliPath, "utf8");
if (!content.startsWith("#!")) {
  writeFileSync(cliPath, `#!/usr/bin/env bun\n${content}`);
}
chmodSync(cliPath, 0o755);
