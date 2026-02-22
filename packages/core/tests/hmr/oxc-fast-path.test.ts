import { describe, expect, test } from "bun:test";
import { detectFastPath, transformForReactRefresh } from "../../src/hmr/transform";

const SRC_DIR = "/fake/project/src";
const PAGES_DIR = "/fake/project/src/pages";
const INDEX_FILE = "/fake/project/src/pages/index.tsx";
const INDEX_MODULE_ID = "/_modules/src/pages/index.tsx";

const REACT_IMPORT_RE = /from\s+["']react["']/;
const ELYSION_CLIENT_IMPORT_RE = /from\s+["']elysion\/client["']/;
const ELYSIA_IMPORT_RE = /from\s+["']elysia["']/;
const HMR_RUNTIME_COMMENT_RE = /^\/\/ HMR Runtime Setup for/;
const ELYSION_PAGE_RE = /ElysionPage/;

function transform(
  code: string,
  options: {
    file?: string;
    moduleId?: string;
    srcDir?: string;
    pagesDir?: string;
  } = {}
): string {
  const {
    file = INDEX_FILE,
    moduleId = INDEX_MODULE_ID,
    srcDir = SRC_DIR,
    pagesDir = PAGES_DIR,
  } = options;
  return transformForReactRefresh(code, file, moduleId, srcDir, pagesDir);
}

describe("detectFastPath", () => {
  test("returns true for file without page() or createRoute()", () => {
    const source = "export default function App() { return null }";
    expect(detectFastPath(source)).toBe(true);
  });

  test("returns true for named function component reference", () => {
    const source = `
      function MyPage() { return null }
      export default route.page({ component: MyPage })
    `;
    expect(detectFastPath(source)).toBe(true);
  });

  test("returns true for const named component reference", () => {
    const source = `
      const MyPage = () => null
      export default route.page({ component: MyPage })
    `;
    expect(detectFastPath(source)).toBe(true);
  });

  test("returns false for inline arrow component", () => {
    const source = `
      export default route.page({ component: (props) => null })
    `;
    expect(detectFastPath(source)).toBe(false);
  });

  test("returns false for inline async arrow component", () => {
    const source = `
      export default route.page({ component: async () => null })
    `;
    expect(detectFastPath(source)).toBe(false);
  });

  test("returns false for inline function expression", () => {
    const source = `
      export default route.page({ component: function() { return null } })
    `;
    expect(detectFastPath(source)).toBe(false);
  });

  test("returns true for createRoute without inline component", () => {
    const source = `
      export const route = createRoute({ mode: "ssg" })
    `;
    expect(detectFastPath(source)).toBe(true);
  });

  test("returns true for named component with loader present", () => {
    const source = `
      async function loader() { return { data: 1 } }
      function MyPage() { return null }
      export default route.page({ loader, component: MyPage })
    `;
    expect(detectFastPath(source)).toBe(true);
  });
});

describe("transformForReactRefresh (fast path via oxc)", () => {
  test("transforms named component with valid JS output", () => {
    const source = `
      function MyPage() { return React.createElement("div", null, "hello") }
      export default route.page({ component: MyPage })
    `;
    const result = transform(source);
    expect(result).toContain("createElement");
    expect(result).not.toContain("<div>");
  });

  test("includes $RefreshReg$ for named component", () => {
    const source = `
      function MyPage() { 
        const [v] = useState(0);
        return React.createElement("div", null, v);
      }
      export default route.page({ component: MyPage })
    `;
    const result = transform(source);
    expect(result).toContain("$RefreshReg$");
  });

  test("rewrites relative imports for fast path", () => {
    const source = `
      import { helper } from "./utils";
      function MyPage() { return helper() }
      export default route.page({ component: MyPage })
    `;
    const result = transform(source);
    expect(result).toContain("/_modules/src/pages/utils");
    expect(result).not.toContain('from "./utils"');
  });

  test("strips server-only imports (react, elysion/client, elysia)", () => {
    const source = `
      import React from "react";
      import { createRoute } from "elysion/client";
      import { t } from "elysia";
      function MyPage() { return null }
      export default route.page({ component: MyPage })
    `;
    const result = transform(source);
    expect(result).not.toMatch(REACT_IMPORT_RE);
    expect(result).not.toMatch(ELYSION_CLIENT_IMPORT_RE);
    expect(result).not.toMatch(ELYSIA_IMPORT_RE);
  });

  test("injects required globals (React, createRoute, t)", () => {
    const source = `
      function MyPage() { return null }
      export default route.page({ component: MyPage })
    `;
    const result = transform(source);
    expect(result).toContain("window.React");
    expect(result).toContain("window.__ELYSION__");
    expect(result).toContain("new Proxy");
  });

  test("output starts with HMR runtime comment", () => {
    const source = `
      function MyPage() { return null }
      export default route.page({ component: MyPage })
    `;
    const result = transform(source);
    expect(result.trimStart()).toMatch(HMR_RUNTIME_COMMENT_RE);
  });

  test("output contains inline source map", () => {
    const source = `
      function MyPage() { return null }
      export default route.page({ component: MyPage })
    `;
    const result = transform(source);
    expect(result).toContain("sourceMappingURL=data:application/json");
  });

  test("strips import.meta.hot blocks", () => {
    const source = `
      function MyPage() { return null }
      export default route.page({ component: MyPage })
      if (import.meta.hot) {
        import.meta.hot.accept();
      }
    `;
    const result = transform(source);
    expect(result).not.toContain("import.meta.hot");
  });
});

describe("transformForReactRefresh (slow path via oxc-parser)", () => {
  test("extracts inline arrow component into named _ElysionPage function", () => {
    const source = `
      export default route.page({ component: (props) => React.createElement("div", null, "hello") })
    `;
    const result = transform(source);
    expect(result).toContain("ElysionPage");
    expect(result).toContain("createElement");
  });

  test("extracts inline function expression into named function", () => {
    const source = `
      export default route.page({ component: function(props) { return React.createElement("div", null) } })
    `;
    const result = transform(source);
    expect(result).toContain("ElysionPage");
  });

  test("removes loader property from page() call", () => {
    const source = `
      export default route.page({
        loader: async () => ({ data: 1 }),
        component: (props) => React.createElement("div", null, props.data)
      })
    `;
    const result = transform(source);
    expect(result).not.toContain("loader:");
    expect(result).not.toContain("async () =>");
  });

  test("removes orphaned imports used only by loader", () => {
    const source = `
      import { getUser } from "./db";
      export default route.page({
        loader: async () => ({ user: await getUser() }),
        component: (props) => React.createElement("div", null)
      })
    `;
    const result = transform(source);
    expect(result).not.toContain("getUser");
    expect(result).not.toContain('from "./db"');
  });

  test("preserves imports used by component", () => {
    const source = `
      import { helper } from "./utils";
      export default route.page({
        loader: async () => ({ data: 1 }),
        component: (props) => React.createElement("div", null, helper())
      })
    `;
    const result = transform(source);
    expect(result).toContain("/_modules/src/pages/utils");
  });

  test("registers extracted component with $RefreshReg$", () => {
    const source = `
      export default route.page({
        component: (props) => {
          const [v] = useState(0);
          return React.createElement("div", null, v);
        }
      })
    `;
    const result = transform(source);
    expect(result).toContain("$RefreshReg$");
    expect(result).toMatch(ELYSION_PAGE_RE);
  });

  test("handles inline component with loader and named component together", () => {
    const source = `
      import { getData } from "./api";
      export default route.page({
        loader: async () => ({ data: await getData() }),
        component: (props) => React.createElement("div", null, "test")
      })
    `;
    const result = transform(source);
    expect(result).not.toContain("loader:");
    expect(result).not.toContain("getData");
    expect(result).toContain("ElysionPage");
  });
});
