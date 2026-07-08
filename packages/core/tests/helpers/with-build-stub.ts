import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type BunBuildGlobal = typeof globalThis & {
  __FURIN_BUN_BUILD_FOR_TESTS?: typeof Bun.build;
};

/**
 * Runs `fn` with `Bun.build` replaced by a lightweight stub that returns a
 * synthetic build output (one JS entry-point + one CSS asset).  The real
 * `Bun.build` is always restored when `fn` resolves or rejects.
 *
 * Captures the *current* value of `Bun.build` at call time (not at module
 * load time) so that nested / overlapping invocations each restore the value
 * that was active before their own stub was installed, rather than always
 * clobbering back to the original real implementation.
 *
 * Used by both build-cli.test.ts and adapter-bun.test.ts to avoid spawning
 * an actual Bun bundler process during unit tests.
 */
export async function withBuildStub<T>(run: () => Promise<T>): Promise<T> {
  let buildCallCount = 0;

  (globalThis as BunBuildGlobal).__FURIN_BUN_BUILD_FOR_TESTS = ((config) => {
    const outdir = (config as Bun.BuildConfig).outdir;
    const compile = (config as Bun.BuildConfig).compile;
    const outfile = typeof compile === "object" ? compile.outfile : undefined;
    if (typeof outfile === "string") {
      mkdirSync(dirname(outfile), { recursive: true });
      writeFileSync(outfile, "#!/usr/bin/env bun\n");
    }
    const outputs: Array<{ kind: string; path: string; size: number }> = [];
    if (buildCallCount++ === 0 && typeof outdir === "string") {
      mkdirSync(outdir, { recursive: true });
      const jsPath = join(outdir, "_hydrate.js");
      const cssPath = join(outdir, "_hydrate.css");
      writeFileSync(jsPath, "export {};\n");
      writeFileSync(cssPath, "body{}\n");
      outputs.push(
        {
          kind: "entry-point",
          path: jsPath,
          size: 128,
        },
        {
          kind: "asset",
          path: cssPath,
          size: 64,
        }
      );
    }

    return Promise.resolve({
      logs: [],
      outputs,
      success: true,
    } as unknown as Bun.BuildOutput);
  }) as typeof Bun.build;

  try {
    return await run();
  } finally {
    (globalThis as BunBuildGlobal).__FURIN_BUN_BUILD_FOR_TESTS = undefined;
  }
}
