import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDevRouteTopologyWatcher, routeSourcePaths } from "../../../src/plugin/routes.ts";

async function waitForCount(readCount: () => number, expected: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (readCount() < expected) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${expected} topology changes`);
    }
    // biome-ignore lint/performance/noAwaitInLoops: bounded polling waits for a native fs event
    await Bun.sleep(10);
  }
}

test("the dev topology watcher reloads only when the route set changes", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "furin-route-watch-"));
  const pagesDir = join(projectRoot, "src/pages");
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(join(pagesDir, "index.ts"), "export const route = 1;\n");

  const topologies: string[][] = [];
  const instance = { pagesDir, prefix: "" };
  const watcher = registerDevRouteTopologyWatcher({
    instance,
    onTopologyChange: () => {
      const paths = routeSourcePaths(instance).map((path) => path.replace(`${pagesDir}/`, ""));
      topologies.push(paths);
    },
    pollIntervalMs: 20,
  });

  try {
    writeFileSync(join(pagesDir, "index.ts"), "export const route = 2;\n");
    await Bun.sleep(80);
    expect(topologies).toHaveLength(0);

    const nestedDir = join(pagesDir, "boards");
    mkdirSync(nestedDir);
    writeFileSync(join(nestedDir, "[id].ts"), "export const route = 1;\n");
    await waitForCount(() => topologies.length, 1);

    expect(topologies[0]).toContain("boards/[id].ts");

    rmSync(join(nestedDir, "[id].ts"));
    await waitForCount(() => topologies.length, 2);
    expect(topologies[1]).toEqual(["index.ts"]);
  } finally {
    watcher.close();
    rmSync(projectRoot, { force: true, recursive: true });
  }
});
