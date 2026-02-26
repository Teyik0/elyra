// @ts-nocheck
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getCachedCss, getCssConfig, invalidateCssCache, setCssConfig } from "../src/css";

// ---------------------------------------------------------------------------
// Temp directory setup
// ---------------------------------------------------------------------------
const TMP_BASE = join(tmpdir(), `elysion-css-tests-${process.pid}`);

beforeEach(() => {
  mkdirSync(TMP_BASE, { recursive: true });
  // Reset config to null before each test
  setCssConfig(undefined, true);
});

afterEach(() => {
  // Invalidate any cached entries so tests don't leak
  const config = getCssConfig();
  if (config) {
    invalidateCssCache(resolve(TMP_BASE, config.input));
  }
  setCssConfig(undefined, true);
  try {
    rmSync(TMP_BASE, { recursive: true, force: true });
  } catch {
    // Cleanup errors don't fail the test
  }
});

// ---------------------------------------------------------------------------
// setCssConfig + getCssConfig — config management
// ---------------------------------------------------------------------------

describe("CSS config management", () => {
  test("setCssConfig without input results in null config", () => {
    setCssConfig(undefined, true);
    expect(getCssConfig()).toBeNull();
  });

  test("setCssConfig with empty input results in null config", () => {
    setCssConfig({}, true);
    expect(getCssConfig()).toBeNull();
  });

  test("setCssConfig with explicit 'inline' mode configures correctly", () => {
    setCssConfig({ input: "styles.css", mode: "inline" }, true);
    const config = getCssConfig();
    expect(config).not.toBeNull();
    expect(config?.input).toBe("styles.css");
    expect(config?.mode).toBe("inline");
  });

  test("setCssConfig with explicit 'external' mode configures correctly", () => {
    setCssConfig({ input: "styles.css", mode: "external" }, false);
    const config = getCssConfig();
    expect(config).not.toBeNull();
    expect(config?.mode).toBe("external");
  });

  test("setCssConfig mode 'auto' resolves to 'inline' in dev", () => {
    setCssConfig({ input: "styles.css", mode: "auto" }, true);
    expect(getCssConfig()?.mode).toBe("inline");
  });

  test("setCssConfig mode 'auto' resolves to 'external' in production", () => {
    setCssConfig({ input: "styles.css", mode: "auto" }, false);
    expect(getCssConfig()?.mode).toBe("external");
  });

  test("setCssConfig defaults to 'auto' when mode is omitted", () => {
    setCssConfig({ input: "styles.css" }, true);
    // auto + dev = inline
    expect(getCssConfig()?.mode).toBe("inline");
  });
});

// ---------------------------------------------------------------------------
// getCachedCss — CSS processing pipeline
// ---------------------------------------------------------------------------

describe("CSS processing pipeline", () => {
  test("getCachedCss returns null when no config is set", async () => {
    const result = await getCachedCss(TMP_BASE);
    expect(result).toBeNull();
  });

  test("getCachedCss processes a real CSS file and returns the code", async () => {
    const cssContent = "body { color: red; }";
    writeFileSync(join(TMP_BASE, "test.css"), cssContent);

    setCssConfig({ input: "test.css", mode: "inline" }, true);
    const result = await getCachedCss(TMP_BASE);

    expect(result).not.toBeNull();
    expect(result?.code).toContain("color: red");
    expect(result?.mode).toBe("inline");
  });

  test("getCachedCss caches the result on second call", async () => {
    writeFileSync(join(TMP_BASE, "cached.css"), "h1 { font-size: 2rem; }");

    setCssConfig({ input: "cached.css", mode: "inline" }, true);
    const first = await getCachedCss(TMP_BASE);
    const second = await getCachedCss(TMP_BASE);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.code).toBe(second?.code);
  });

  test("invalidateCssCache forces re-processing on next call", async () => {
    const cssPath = join(TMP_BASE, "invalidate.css");
    writeFileSync(cssPath, "p { margin: 0; }");

    setCssConfig({ input: "invalidate.css", mode: "inline" }, true);

    // First call — populates cache
    const first = await getCachedCss(TMP_BASE);
    expect(first?.code).toContain("margin: 0");

    // Mutate the file on disk
    writeFileSync(cssPath, "p { margin: 10px; }");

    // Invalidate so next call re-reads from disk
    invalidateCssCache(resolve(TMP_BASE, "invalidate.css"));

    const second = await getCachedCss(TMP_BASE);
    expect(second?.code).toContain("margin: 10px");
  });

  test("getCachedCss throws when CSS file does not exist", () => {
    setCssConfig({ input: "nonexistent.css", mode: "inline" }, true);

    expect(getCachedCss(TMP_BASE)).rejects.toThrow("CSS file not found");
  });

  test("getCachedCss works without a postcss config (plain CSS passthrough)", async () => {
    // No postcss.config.* files in TMP_BASE — plain passthrough
    const cssContent = ".card { display: flex; gap: 1rem; }";
    writeFileSync(join(TMP_BASE, "plain.css"), cssContent);

    setCssConfig({ input: "plain.css", mode: "external" }, false);
    const result = await getCachedCss(TMP_BASE);

    expect(result).not.toBeNull();
    expect(result?.code).toContain("display: flex");
    expect(result?.mode).toBe("external");
  });

  test("getCachedCss uses a postcss.config.mjs if present in cwd", async () => {
    // Create a minimal postcss config that exports an empty plugins object
    // This exercises findPostcssConfig + loadPostcssConfig + resolvePlugins
    const configContent = "export default { plugins: {} };";
    writeFileSync(join(TMP_BASE, "postcss.config.mjs"), configContent);

    const cssContent = "a { text-decoration: none; }";
    writeFileSync(join(TMP_BASE, "styled.css"), cssContent);

    setCssConfig({ input: "styled.css", mode: "inline" }, true);
    const result = await getCachedCss(TMP_BASE);

    expect(result).not.toBeNull();
    // Even with empty plugins, PostCSS should return the CSS
    expect(result?.code).toContain("text-decoration: none");
  });
});
