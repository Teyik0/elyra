import { resolve } from "node:path";

const INSTRUMENTATION_IMPORT = /(?:^|[/\\])devtools[/\\]instrumentation(?:\.ts|\.js)?$/;

export function productionInstrumentationPlugin(): Bun.BunPlugin {
  return {
    name: "furin-production-instrumentation",
    setup(build) {
      build.onResolve({ filter: INSTRUMENTATION_IMPORT }, () => ({
        path: resolve(import.meta.dir, "../server/devtools/instrumentation.production.ts"),
      }));
    },
  };
}
