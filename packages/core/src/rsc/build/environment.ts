export type FurinGraph = "client" | "rsc" | "ssr";

const SERVER_ONLY_RE = /^(?:@teyik0\/)?furin\/server-only$/;
const CLIENT_ONLY_RE = /^(?:@teyik0\/)?furin\/client-only$/;

export function environmentGuardPlugin(graph: FurinGraph): Bun.BunPlugin {
  return {
    name: `furin-environment-${graph}`,
    setup(build) {
      build.onResolve({ filter: SERVER_ONLY_RE }, (args) => {
        if (graph === "client") {
          throw new Error(
            `[furin] ${args.importer} imports furin/server-only from the client graph.`
          );
        }
        return { path: import.meta.resolve("../../server-only.ts") };
      });
      build.onResolve({ filter: CLIENT_ONLY_RE }, (args) => {
        if (graph !== "client") {
          throw new Error(
            `[furin] ${args.importer} imports furin/client-only from the ${graph} graph.`
          );
        }
        return { path: import.meta.resolve("../../client-only.ts") };
      });
    },
  };
}
