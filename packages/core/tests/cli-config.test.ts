import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadCliConfig, resolveServerEntrypoint } from "../src/cli/config";
import { createTmpApp, removeAppPath, writeAppFile } from "./helpers/tmp-app";

const tmpApps: Array<{ cleanup: () => void }> = [];

function rememberTmpApp<T extends { cleanup: () => void }>(app: T): T {
  tmpApps.push(app);
  return app;
}

afterEach(() => {
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

describe("CLI config resolution", () => {
  test("loadCliConfig uses defaults when no config file is present", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    const result = await loadCliConfig(app.path);

    expect(result.configPath).toBeNull();
    expect(result.rootDir).toBe(app.path);
    expect(result.pagesDir).toBe(join(app.path, "src/pages"));
  });

  test("loadCliConfig loads values from elyra.config.ts", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    writeAppFile(
      app.path,
      "elyra.config.ts",
      [
        'import { defineConfig } from "elyra/config";',
        "export default defineConfig({",
        '  pagesDir: "src/custom-pages",',
        '  outDir: ".output/elyra",',
        "  client: { minify: false, sourcemap: true },",
        "});",
      ].join("\n")
    );

    const result = await loadCliConfig(app.path);

    expect(result.configPath).toBe(join(app.path, "elyra.config.ts"));
    expect(result.pagesDir).toBe(join(app.path, "src/custom-pages"));
    expect(result.outDir).toBe(".output/elyra");
    expect(result.client).toEqual({ minify: false, sourcemap: true });
  });

  test("resolveServerEntrypoint prefers src/server.bun.ts over src/server.ts", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    writeAppFile(app.path, "src/server.bun.ts", 'console.log("bun server");');

    expect(resolveServerEntrypoint(app.path, "bun")).toBe(join(app.path, "src/server.bun.ts"));
  });

  test("resolveServerEntrypoint falls back to src/server.ts", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));

    expect(resolveServerEntrypoint(app.path, "bun")).toBe(join(app.path, "src/server.ts"));
  });

  test("resolveServerEntrypoint falls back to src/app.ts when src/server.ts is absent", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    removeAppPath(app.path, "src/server.ts");
    writeAppFile(app.path, "src/app.ts", 'console.log("app entry");');

    expect(resolveServerEntrypoint(app.path, "bun")).toBe(join(app.path, "src/app.ts"));
  });

  test("resolveServerEntrypoint returns null when no entrypoint is found", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    removeAppPath(app.path, "src/server.ts");

    expect(resolveServerEntrypoint(app.path, "bun")).toBeNull();
  });

  // RED: plugins must survive TypeBox validation and be returned
  test("loadCliConfig preserves plugins array through TypeBox validation", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    writeAppFile(
      app.path,
      "elyra.config.ts",
      [
        'import { defineConfig } from "elyra/config";',
        'const mockPlugin: import("elyra/config").BunPlugin = { name: "test-plugin", setup() {} };',
        "export default defineConfig({ plugins: [mockPlugin] });",
      ].join("\n")
    );

    const result = await loadCliConfig(app.path);

    expect(result.plugins).toHaveLength(1);
    expect((result.plugins ?? [])[0]?.name).toBe("test-plugin");
  });

  // RED: plugins alongside other fields must not break validation
  test("loadCliConfig preserves plugins alongside other config fields", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    writeAppFile(
      app.path,
      "elyra.config.ts",
      [
        'import { defineConfig } from "elyra/config";',
        'const p: import("elyra/config").BunPlugin = { name: "p", setup() {} };',
        "export default defineConfig({",
        '  outDir: ".out",',
        "  client: { minify: false },",
        "  plugins: [p],",
        "});",
      ].join("\n")
    );

    const result = await loadCliConfig(app.path);

    expect(result.outDir).toBe(".out");
    expect(result.client?.minify).toBe(false);
    expect((result.plugins ?? [])[0]?.name).toBe("p");
  });
});
