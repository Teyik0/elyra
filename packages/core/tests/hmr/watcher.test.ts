import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  broadcastMessage,
  getModuleVersion,
  getTransformedModule,
  invalidateModuleCache,
  persistHmrState,
} from "../../src/hmr/watcher";

// ---------------------------------------------------------------------------
// Temp directory setup
// A fresh directory tree is created before each test and torn down after.
// ---------------------------------------------------------------------------
const TMP_BASE = join(tmpdir(), "elysion-watcher-tests");
const SRC_DIR = TMP_BASE;
const PAGES_DIR = join(TMP_BASE, "pages");

/** Write a .tsx file inside the temp pages directory and return its full path. */
async function writePage(name: string, content: string): Promise<string> {
  const filePath = join(PAGES_DIR, name);
  await Bun.write(filePath, content);
  return filePath;
}

beforeEach(() => {
  mkdirSync(PAGES_DIR, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(TMP_BASE, { recursive: true, force: true });
  } catch {
    // Cleanup errors don't fail the test
  }
});

// ---------------------------------------------------------------------------
// getTransformedModule — basic functionality
// Each call reads from disk and transforms fresh (no in-process cache).
// ---------------------------------------------------------------------------
describe("getTransformedModule — basic functionality", () => {
  test("transforms a real file and returns a non-empty JS string", async () => {
    const filePath = await writePage("index.tsx", "export const App = () => null;");
    const result = await getTransformedModule(filePath, SRC_DIR, PAGES_DIR);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("two calls with the same file return equal content", async () => {
    const filePath = await writePage("double.tsx", "export const x = 1;");
    const first = await getTransformedModule(filePath, SRC_DIR, PAGES_DIR);
    const second = await getTransformedModule(filePath, SRC_DIR, PAGES_DIR);
    expect(first).toEqual(second);
  });
});

// ---------------------------------------------------------------------------
// getTransformedModule — output content
// The transformed code must satisfy the contracts the client runtime expects.
// ---------------------------------------------------------------------------
describe("getTransformedModule — output content", () => {
  test("output contains the HMR $RefreshReg$ wrapper", async () => {
    const filePath = await writePage("hmr.tsx", "export const App = () => null;");
    const result = await getTransformedModule(filePath, SRC_DIR, PAGES_DIR);
    expect(result).toContain("$RefreshReg$");
  });

  test("output contains injected globals (window.React)", async () => {
    const filePath = await writePage("globals.tsx", "export const x = 1;");
    const result = await getTransformedModule(filePath, SRC_DIR, PAGES_DIR);
    expect(result).toContain("window.React");
  });

  test("module ID in output is derived from the path relative to srcDir", async () => {
    const filePath = await writePage("about.tsx", "export const x = 1;");
    const result = await getTransformedModule(filePath, SRC_DIR, PAGES_DIR);
    // srcDir = TMP_BASE, file = TMP_BASE/pages/about.tsx
    // relative path from srcDir = pages/about.tsx
    // expected module ID = /_modules/src/pages/about.tsx
    expect(result).toContain("/_modules/src/pages/about.tsx");
  });
});

// ---------------------------------------------------------------------------
// getTransformedModule — error cases
// ---------------------------------------------------------------------------
describe("getTransformedModule — error cases", () => {
  test("throws with a descriptive message for a missing file", () => {
    expect(getTransformedModule("/nonexistent/file.tsx", SRC_DIR, PAGES_DIR)).rejects.toThrow(
      "File not found"
    );
  });
});

// ---------------------------------------------------------------------------
// Module version counter
// Validates that the per-file version API used in render.tsx to avoid the
// Date.now() memory leak works correctly.
// ---------------------------------------------------------------------------
describe("module version counter", () => {
  // Use a path that is isolated from any real on-disk file.
  const PATH_A = "/virtual/path/to/page-a.tsx";
  const PATH_B = "/virtual/path/to/page-b.tsx";

  test("returns 0 for an untracked path", () => {
    expect(getModuleVersion("/this/path/was/never/touched.tsx")).toBe(0);
  });

  test("increments version by 1 on each invalidation", () => {
    expect(getModuleVersion(PATH_A)).toBe(0);
    invalidateModuleCache(PATH_A);
    expect(getModuleVersion(PATH_A)).toBe(1);
    invalidateModuleCache(PATH_A);
    expect(getModuleVersion(PATH_A)).toBe(2);
  });

  test("versions are tracked independently per path", () => {
    invalidateModuleCache(PATH_B);
    // PATH_B was incremented once; PATH_A's count must be unaffected
    // (PATH_A was already incremented twice above, still 2)
    expect(getModuleVersion(PATH_A)).toBe(2);
    expect(getModuleVersion(PATH_B)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getTransformedModule — non-page files (Bun.build() branch)
// Files outside pagesDir are bundled with Bun.build() instead of being
// transformed with React Refresh.
// ---------------------------------------------------------------------------
describe("getTransformedModule — non-page files (Bun.build branch)", () => {
  test("file outside pagesDir is bundled via Bun.build and returns ESM", async () => {
    // Create a file at TMP_BASE/utils.ts — outside PAGES_DIR (TMP_BASE/pages/)
    const utilsPath = join(TMP_BASE, "utils.ts");
    await Bun.write(utilsPath, "export const helper = (x: number) => x * 2;");

    const result = await getTransformedModule(utilsPath, SRC_DIR, PAGES_DIR);

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    // Must contain the exported function (bundled as ESM)
    expect(result).toContain("helper");
  });

  test("result is cached — second call returns the same code", async () => {
    const utilsPath = join(TMP_BASE, "cached-util.ts");
    await Bun.write(utilsPath, "export const add = (a: number, b: number) => a + b;");

    const first = await getTransformedModule(utilsPath, SRC_DIR, PAGES_DIR);
    const second = await getTransformedModule(utilsPath, SRC_DIR, PAGES_DIR);

    expect(first).toBe(second);
  });

  test("throws when Bun.build fails for invalid syntax", async () => {
    const badPath = join(TMP_BASE, "bad-syntax.ts");
    await Bun.write(badPath, "export const x = {{{INVALID}}};");

    expect(getTransformedModule(badPath, SRC_DIR, PAGES_DIR)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// broadcastMessage — no-op when no clients are connected
// ---------------------------------------------------------------------------
describe("broadcastMessage", () => {
  test("does not throw when no clients are connected", () => {
    expect(() => broadcastMessage("test")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// persistHmrState — saves module state for hot reload persistence
// ---------------------------------------------------------------------------
describe("persistHmrState", () => {
  test("persists clients, moduleVersions, and builtModuleCache to data object", () => {
    const data: Record<string, unknown> = {};
    persistHmrState(data);

    expect(data.clients).toBeInstanceOf(Set);
    expect(data.moduleVersions).toBeInstanceOf(Map);
    expect(data.builtModuleCache).toBeInstanceOf(Map);
  });
});
