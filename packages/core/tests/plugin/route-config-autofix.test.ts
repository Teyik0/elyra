import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  expectedLayoutFor,
  fixRouteConfigLayout,
  layoutIdentifierFor,
} from "../../src/plugin/route-config-autofix.ts";

const TMP_ROOT = join(import.meta.dir, "../../.tmp-tests");

function createPages(files: Record<string, string>): { cleanup: () => void; path: string } {
  const path = mkdtempSync(join(TMP_ROOT, "autofix-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = join(path, relativePath);
    mkdirSync(absolute.slice(0, absolute.lastIndexOf("/")), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return { cleanup: () => rmSync(path, { force: true, recursive: true }), path };
}

const ROOT_LAYOUT = `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute().layout(({ children }) => children);
`;

describe("layoutIdentifierFor", () => {
  test("derives the binding from the layout directory", () => {
    expect(layoutIdentifierFor("/app/pages/root.tsx")).toBe("rootRoute");
    expect(layoutIdentifierFor("/app/pages/board/_route.tsx")).toBe("boardRoute");
    expect(layoutIdentifierFor("/app/pages/docs/api/_route.tsx")).toBe("apiRoute");
    expect(layoutIdentifierFor("/app/pages/[boardId]/_route.tsx")).toBe("boardIdRoute");
  });
});

describe("expectedLayoutFor", () => {
  test("resolves the nearest _route walking up", () => {
    const pages = createPages({
      "board/_route.tsx": "",
      "board/index.tsx": "",
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const expected = expectedLayoutFor(join(pages.path, "board/index.tsx"), pages.path);
      expect(expected?.identifier).toBe("boardRoute");
      expect(expected?.importPath).toBe("./_route");
    } finally {
      pages.cleanup();
    }
  });

  test("a _route file references the layout of its PARENT directory", () => {
    const pages = createPages({
      "board/_route.tsx": "",
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const expected = expectedLayoutFor(join(pages.path, "board/_route.tsx"), pages.path);
      expect(expected?.identifier).toBe("rootRoute");
      expect(expected?.importPath).toBe("../root");
    } finally {
      pages.cleanup();
    }
  });

  test("falls back to the root.tsx convention", () => {
    const pages = createPages({ "about.tsx": "", "root.tsx": ROOT_LAYOUT });
    try {
      const expected = expectedLayoutFor(join(pages.path, "about.tsx"), pages.path);
      expect(expected?.identifier).toBe("rootRoute");
      expect(expected?.importPath).toBe("./root");
    } finally {
      pages.cleanup();
    }
  });

  test("the root layout itself has no expected layout", () => {
    const pages = createPages({ "root.tsx": ROOT_LAYOUT });
    try {
      expect(expectedLayoutFor(join(pages.path, "root.tsx"), pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });
});

describe("fixRouteConfigLayout", () => {
  test("injects the missing layout and its import", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute()
  .config({ mode: "ssr" })
  .page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain('import { route as rootRoute } from "./root";');
      expect(fixed).toContain('config({ layout: rootRoute, mode: "ssr" })');
      // idempotent: second pass changes nothing
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("reuses an existing binding that already points at the expected module", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as parentRoute } from "./root";

export const route = defineRoute()
  .config({ mode: "ssr" })
  .page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      const fixed = fixRouteConfigLayout(String(readFile(filePath)), filePath, pages.path);
      expect(fixed).toContain("layout: parentRoute");
      expect(fixed).not.toContain("rootRoute");
    } finally {
      pages.cleanup();
    }
  });

  test("repoints a layout reference that targets the wrong module", () => {
    const pages = createPages({
      "board/_route.tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute().layout(({ children }) => children);
`,
      "board/[id].tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../root";

export const route = defineRoute()
  .config({ mode: "ssr", layout: rootRoute })
  .page(() => "post");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "board/[id].tsx");
      const fixed = fixRouteConfigLayout(String(readFile(filePath)), filePath, pages.path);
      expect(fixed).toContain("layout: boardRoute");
      expect(fixed).toContain('import { route as boardRoute } from "./_route";');
    } finally {
      pages.cleanup();
    }
  });

  test("leaves non-identifier layout expressions untouched", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ mode: "ssr", layout: condition ? rootRoute : undefined })
  .page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      const source = String(readFile(filePath));
      expect(fixRouteConfigLayout(source, filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("returns null for files without defineRoute or without a config object", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute().page(() => "about");
`,
      "raw.ts": `import { Elysia } from "elysia";
export const route = { elysia: new Elysia().get("/", () => "raw") };
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const rawPath = join(pages.path, "raw.ts");
      expect(fixRouteConfigLayout(String(readFile(rawPath)), rawPath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("inserts a full config on a chain without one", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute().page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain(`.config({ layout: rootRoute, mode: "ssr" }).page(() => "about")`);
      // idempotent: second pass changes nothing
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("injects the missing mode alongside an existing layout", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ layout: rootRoute })
  .page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain('config({ mode: "ssr", layout: rootRoute })');
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("the root layout file only receives a mode (defineRootRoute)", () => {
    const pages = createPages({
      "root.tsx": `import { defineRootRoute } from "@teyik0/furin";
export const route = defineRootRoute().layout(({ children }) => children);
`,
    });
    try {
      const filePath = join(pages.path, "root.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain('.config({ mode: "ssr" })');
      expect(fixed).not.toContain("layout:");
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });
});

function readFile(path: string): string {
  return readFileSync(path, "utf8");
}
