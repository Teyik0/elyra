import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { scanPages } from "../../src/router";
import { collectRouteChain } from "../../src/utils";

const FIXTURES_DIR = join(import.meta.dirname, "../fixtures/pages");

describe("E2E: route chain works without routeFilePaths", () => {
  test("scanPages correctly builds route chain for nested page", async () => {
    const result = await scanPages(FIXTURES_DIR);

    expect(result.root).not.toBeNull();
    expect(result.routes.length).toBeGreaterThan(0);

    const nestedRoute = result.routes.find((r) => r.pattern === "/nested");
    expect(nestedRoute).toBeDefined();
    expect(nestedRoute?.page).toBeDefined();

    const chain = collectRouteChain(nestedRoute?.page);

    expect(chain.length).toBeGreaterThanOrEqual(2);
    expect(chain[0]?.layout).toBeDefined();
    expect(chain[1]?.layout).toBeDefined();
  });

  test("scanPages handles deeply nested layouts (3 levels)", async () => {
    const result = await scanPages(FIXTURES_DIR);

    const deepRoute = result.routes.find((r) => r.pattern === "/nested/deep");
    expect(deepRoute).toBeDefined();
    expect(deepRoute?.page).toBeDefined();

    const chain = collectRouteChain(deepRoute?.page);

    expect(chain).toHaveLength(3);
    expect(chain[0]?.layout).toBeDefined();
    expect(chain[1]?.layout).toBeDefined();
    expect(chain[2]?.layout).toBeDefined();
  });

  test("scanPages supports inline layout (no route.tsx needed)", async () => {
    const result = await scanPages(FIXTURES_DIR);

    const inlineRoute = result.routes.find((r) => r.pattern === "/inline-layout");
    expect(inlineRoute).toBeDefined();
    expect(inlineRoute?.page).toBeDefined();

    const chain = collectRouteChain(inlineRoute?.page);

    expect(chain).toHaveLength(2);
    expect(chain[0]?.layout).toBeDefined();
    expect(chain[1]?.layout).toBeDefined();
  });

  test("scanPages supports skipping layouts (level 3 uses root directly)", async () => {
    const result = await scanPages(FIXTURES_DIR);

    const skipRoute = result.routes.find((r) => r.pattern === "/skip-layout");
    expect(skipRoute).toBeDefined();
    expect(skipRoute?.page).toBeDefined();

    const chain = collectRouteChain(skipRoute?.page);

    expect(chain).toHaveLength(1);
    expect(chain[0]).toBe(result.root?.route);
  });

  test("all routes have root in their chain", async () => {
    const result = await scanPages(FIXTURES_DIR);

    for (const route of result.routes) {
      if (route.page) {
        const chain = collectRouteChain(route.page);
        const hasRoot = chain.some((r) => r === result.root?.route);
        expect(hasRoot, `Route ${route.pattern} should have root in chain`).toBe(true);
      }
    }
  });
});
