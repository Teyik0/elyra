import { describe, expect, test } from "bun:test";
import MagicString from "magic-string";
import { deadCodeElimination, transformForClient } from "../src/plugin/transform-client";

// ---------------------------------------------------------------------------
// Top-level regex constants (satisfies lint/performance/useTopLevelRegex)
// ---------------------------------------------------------------------------
const LOADER_PROPERTY_RE = /\bloader\s*:/;
/** Matches `from "./db"` or `from './db'` with any whitespace and quote style. */
const IMPORT_DB_RE = /from\s+["']\.\/db["']/;
/** Same as above but allows any non-quote prefix in the path (e.g. `../../db`). */
const IMPORT_RELATIVE_DB_RE = /from\s+["'][^"']*db["']/;
/** Quoted form of a `loader` property key (`"loader":` or `'loader':`). */
const QUOTED_LOADER_KEY_RE = /["']loader["']\s*:/;
/** Bare `UI` identifier — used to verify a JSX MemberExpression root binding survives DCE. */
const BARE_UI_RE = /\bUI\b/;
/** Matches `from "./styles"` or `from './styles'` — used for DCE assertions. */
const IMPORT_STYLES_RE = /from\s+["']\.\/styles["']/;

// ---------------------------------------------------------------------------
// Basic transformation
// ---------------------------------------------------------------------------

describe("transformForClient — basic", () => {
  test("code without server props is returned with removedServerCode=false", () => {
    const result = transformForClient("export const x = 1;", "test.tsx");

    expect(result.removedServerCode).toBe(false);
    expect(result.code).toContain("x = 1");
    expect(typeof result.code).toBe("string");
  });

  test("throws on unparseable code", () => {
    expect(() => transformForClient("<<<invalid>>>", "bad.tsx")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Server property removal — page()
// ---------------------------------------------------------------------------

describe("transformForClient — page() loader removal", () => {
  test("removes loader from page() call", () => {
    const input = `
      const result = page({
        loader: async () => ({ data: 1 }),
        component: (props) => null,
      });
    `;
    const result = transformForClient(input, "test.tsx");

    expect(result.code).not.toMatch(LOADER_PROPERTY_RE);
    expect(result.code).toContain("component");
    expect(result.removedServerCode).toBe(true);
  });

  test("removes loader from export default page()", () => {
    const input = `
      export default page({
        loader: async () => ({ data: 1 }),
        component: (props) => null,
      });
    `;
    const result = transformForClient(input, "test.tsx");

    expect(result.code).not.toMatch(LOADER_PROPERTY_RE);
    expect(result.code).toContain("component");
    expect(result.removedServerCode).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Server property removal — createRoute()
// ---------------------------------------------------------------------------

describe("transformForClient — createRoute() loader removal", () => {
  test("removes loader from createRoute()", () => {
    const input = `
      const route = createRoute({
        loader: async () => ({ user: "test" }),
        mode: "ssr",
      });
    `;
    const result = transformForClient(input, "test.tsx");

    expect(result.code).not.toMatch(LOADER_PROPERTY_RE);
    expect(result.code).toContain("mode");
    expect(result.removedServerCode).toBe(true);
  });

  test("removes loader from export default createRoute()", () => {
    const input = `
      export default createRoute({
        loader: async () => ({ user: "test" }),
        mode: "ssr",
      });
    `;
    const result = transformForClient(input, "test.tsx");

    expect(result.code).not.toMatch(LOADER_PROPERTY_RE);
    expect(result.code).toContain("mode");
    expect(result.removedServerCode).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Server property removal — route.page() (member expression)
// ---------------------------------------------------------------------------

describe("transformForClient — route.page() loader removal", () => {
  test("removes loader from route.page() member expression", () => {
    const input = `
      const route = createRoute({ mode: "ssr" });
      export default route.page({
        loader: async ({ user }) => ({ posts: [] }),
        component: ({ user, posts }) => null,
      });
    `;
    const result = transformForClient(input, "test.tsx");

    expect(result.code).not.toMatch(LOADER_PROPERTY_RE);
    expect(result.code).toContain("component");
    expect(result.removedServerCode).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dead code elimination
// ---------------------------------------------------------------------------

describe("transformForClient — dead code elimination", () => {
  test("import used only by loader is eliminated after loader removal", () => {
    const input = `
      import { getUser } from "./db";
      const route = createRoute({
        loader: async () => ({ user: getUser() }),
        mode: "ssr",
      });
    `;
    const result = transformForClient(input, "test.tsx");

    // getUser was only used in the loader → import should be removed
    expect(result.code).not.toMatch(IMPORT_DB_RE);
    expect(result.removedServerCode).toBe(true);
  });

  test("createRoute loader-only import removed when layout with JSX also exists", () => {
    const input = `
      import { queries } from "../../db";
      import { route as rootRoute } from "../root";
      export const route = createRoute({
        parent: rootRoute,
        loader: () => {
          const posts = queries.getPosts.all();
          return { posts };
        },
        layout: ({ children }) => <div>{children}</div>,
      });
    `;
    const result = transformForClient(input, "test.tsx");

    expect(result.code).not.toMatch(IMPORT_RELATIVE_DB_RE);
    expect(result.removedServerCode).toBe(true);
  });

  test("route.page() loader-only import removed when component also exists", () => {
    const input = `
      import { queries } from "../../db";
      import { route } from "./route";
      export default route.page({
        loader: () => {
          const posts = queries.getPosts.all();
          return { posts };
        },
        component: ({ posts }) => <ul>{posts.map(p => <li key={p.id}>{p.title}</li>)}</ul>,
      });
    `;
    const result = transformForClient(input, "test.tsx");

    expect(result.code).not.toMatch(IMPORT_RELATIVE_DB_RE);
    expect(result.removedServerCode).toBe(true);
  });

  test("import used by component is preserved after loader removal", () => {
    const input = `
      import { formatDate } from "./utils";
      export default page({
        loader: async () => ({ data: 1 }),
        component: (props) => formatDate(props.data),
      });
    `;
    const result = transformForClient(input, "test.tsx");

    // formatDate is used in component → import must survive
    expect(result.code).toContain("formatDate");
    expect(result.code).toContain("component");
    expect(result.removedServerCode).toBe(true);
  });

  test("removes only unused specifiers when some are still referenced", () => {
    // getUser only used in loader (removed) → should be stripped
    // formatDate used in component (kept) → must survive
    const input = `
      import { getUser, formatDate } from "./db";
      export default page({
        loader: async () => ({ user: getUser() }),
        component: (props) => formatDate(props.data),
      });
    `;
    const result = transformForClient(input, "test.tsx");

    expect(result.removedServerCode).toBe(true);
    expect(result.code).not.toContain("getUser");
    expect(result.code).toContain("formatDate");
    // Import statement kept but without getUser specifier
    expect(result.code).toMatch(IMPORT_DB_RE);
  });

  test("import used only as a JSX tag is preserved after loader removal", () => {
    // Regression: yuku-parser parses TSX directly (no transpile step), so
    // `<Link>` references show up as `JSXIdentifier`, not `Identifier`. The
    // DCE must treat JSX tag positions as references — otherwise this import
    // is silently dropped and the browser hits "Link is not defined" at
    // runtime as soon as a route both has a `loader` and renders the link.
    const input = `
      import { Link } from "@teyik0/furin/link";
      export default page({
        loader: async () => ({ items: [] }),
        component: () => <Link to="/foo">Hello</Link>,
      });
    `;
    const result = transformForClient(input, "test.tsx");

    expect(result.removedServerCode).toBe(true);
    expect(result.code).toContain("Link");
    expect(result.code).toContain('from "@teyik0/furin/link"');
  });

  test("import used only inside a JSX MemberExpression tag is preserved", () => {
    // Regression: <Namespace.Component /> uses `Namespace` as a reference but
    // the property `Component` is NOT a reference — the DCE must collect the
    // *root* of the JSXMemberExpression chain without falsely treating the
    // `.Component` part as a same-named identifier reference.
    const input = `
      import { UI } from "./ui";
      export default page({
        loader: async () => ({}),
        component: () => <UI.Button label="ok" />,
      });
    `;
    const result = transformForClient(input, "test.tsx");

    expect(result.removedServerCode).toBe(true);
    expect(result.code).toContain('from "./ui"');
    expect(result.code).toMatch(BARE_UI_RE);
  });

  test("import sharing a name with a JSX attribute key is still pruned when unused", () => {
    // Regression guard: `<div className="...">` must NOT count `className` as
    // a reference to a same-named import. This is the analogue of the
    // existing `Property` / `MemberExpression.property` exclusions, but for
    // JSXAttribute.name positions.
    const input = `
      import { className } from "./styles";
      export default page({
        loader: async () => ({}),
        component: () => <div className="static" />,
      });
    `;
    const result = transformForClient(input, "test.tsx");

    expect(result.removedServerCode).toBe(true);
    // The string "className" still appears as the JSX attribute, but the
    // *import* declaration must be gone — otherwise the JSX attribute key
    // would falsely keep dead imports alive forever.
    expect(result.code).not.toMatch(IMPORT_STYLES_RE);
  });
});

// ---------------------------------------------------------------------------
// Computed and quoted property keys
// ---------------------------------------------------------------------------

describe("transformForClient — property key variants", () => {
  test("does not remove computed property keys (computed: true)", () => {
    // `{ [serverOnlyKey]: fn }` — AST marks this as computed, must be preserved
    const input = `
      const serverOnlyKey = "loader";
      export default page({
        [serverOnlyKey]: async () => ({ data: 1 }),
        component: () => null,
      });
    `;
    const result = transformForClient(input, "test.tsx");

    // Computed key is NOT a server-only identifier reference → not removed
    expect(result.removedServerCode).toBe(false);
  });

  test("removes quoted string key 'loader'", () => {
    const input = `
      export default page({
        "loader": async () => ({ data: 1 }),
        component: () => null,
      });
    `;
    const result = transformForClient(input, "test.tsx");

    expect(result.removedServerCode).toBe(true);
    expect(result.code).not.toMatch(LOADER_PROPERTY_RE);
    // Belt-and-suspenders: explicitly assert the quoted form is also gone,
    // independent of LOADER_PROPERTY_RE's word-boundary semantics.  A bug
    // that only stripped bare `loader:` keys would leave `"loader":` behind.
    expect(result.code).not.toMatch(QUOTED_LOADER_KEY_RE);
    expect(result.code).not.toContain('"loader"');
    expect(result.code).toContain("component");
  });

  test("removes quoted string key 'query'", () => {
    const input = `
      export const route = createRoute({
        "query": { type: "object" },
        layout: ({ children }) => children,
      });
    `;
    const result = transformForClient(input, "test.tsx");

    expect(result.removedServerCode).toBe(true);
    expect(result.code).not.toContain('"query"');
    expect(result.code).toContain("layout");
  });
});

// ---------------------------------------------------------------------------
// Windows CRLF line endings
// ---------------------------------------------------------------------------

describe("transformForClient — Windows CRLF", () => {
  test("removes loader from code with CRLF line endings", () => {
    const input =
      "export default page({\r\n  loader: async () => ({ data: 1 }),\r\n  component: () => null,\r\n});";
    const result = transformForClient(input, "test.tsx");

    expect(result.removedServerCode).toBe(true);
    expect(result.code).not.toMatch(LOADER_PROPERTY_RE);
    expect(result.code).toContain("component");
  });
});

// ---------------------------------------------------------------------------
// deadCodeElimination — parse error guard
// ---------------------------------------------------------------------------

describe("deadCodeElimination — parse error recovery", () => {
  test("returns input unchanged when transformed code is unparseable", () => {
    // Feed deliberately invalid JS to DCE — it must not throw
    const broken = new MagicString("import { x } from 'y'; <<<INVALID>>>");
    const result = deadCodeElimination(broken, "tsx");

    // Returns the same string unchanged (not null, not throws)
    expect(result.toString()).toBe("import { x } from 'y'; <<<INVALID>>>");
  });
});

// ---------------------------------------------------------------------------
// TypeScript syntax — exercised because yuku-parser now parses TS directly
// (no Bun.Transpiler pre-pass). These cases would previously have been
// silently stripped by the transpiler before ever reaching the AST walk.
// ---------------------------------------------------------------------------

const ROUTECONFIG_TYPE_RE = /:\s*RouteConfig\b/;

describe("transformForClient — TypeScript syntax", () => {
  test("strips loader when call argument is wrapped in `as Config`", () => {
    const input = `
      const route = createRoute({
        loader: async () => ({ user: "test" }),
        mode: "ssr",
      } as RouteConfig);
    `;
    const result = transformForClient(input, "test.tsx");

    expect(result.removedServerCode).toBe(true);
    expect(result.code).not.toMatch(LOADER_PROPERTY_RE);
    expect(result.code).toContain("mode");
  });

  test("strips loader when call argument is wrapped in `satisfies RouteConfig`", () => {
    const input = `
      const route = createRoute({
        loader: async () => ({ user: "test" }),
        mode: "ssr",
      } satisfies RouteConfig);
    `;
    const result = transformForClient(input, "test.tsx");

    expect(result.removedServerCode).toBe(true);
    expect(result.code).not.toMatch(LOADER_PROPERTY_RE);
    expect(result.code).toContain("mode");
  });

  test("strips loader when call argument is wrapped in parentheses", () => {
    const input = `
      const route = createRoute(({
        loader: async () => ({ user: "test" }),
        mode: "ssr",
      }));
    `;
    const result = transformForClient(input, "test.tsx");

    expect(result.removedServerCode).toBe(true);
    expect(result.code).not.toMatch(LOADER_PROPERTY_RE);
  });

  test("strips loader when surrounding code has type annotations", () => {
    const input = `
      type Loader = () => Promise<{ x: number }>;
      const handler: Loader = async () => ({ x: 1 });
      const config: RouteConfig = createRoute({
        loader: handler,
        mode: "ssr",
      });
    `;
    const result = transformForClient(input, "test.tsx");

    expect(result.removedServerCode).toBe(true);
    expect(result.code).not.toMatch(LOADER_PROPERTY_RE);
    // The TS type annotation around `config` must survive — Bun.build strips it later.
    expect(result.code).toMatch(ROUTECONFIG_TYPE_RE);
  });

  test("strips loader inside a generic call createRoute<T>({...})", () => {
    const input = `
      const route = createRoute<{ user: string }>({
        loader: async () => ({ user: "x" }),
        mode: "ssr",
      });
    `;
    const result = transformForClient(input, "test.tsx");

    expect(result.removedServerCode).toBe(true);
    expect(result.code).not.toMatch(LOADER_PROPERTY_RE);
  });

  test("preserves `import type` declarations through DCE", () => {
    // `import type` is value-erased by the bundler; our DCE must not crash on it.
    const input = `
      import type { RouteConfig } from "furin/client";
      import { queries } from "../../db";
      export const route = createRoute({
        loader: () => ({ posts: queries.getPosts.all() }),
        mode: "ssr",
      });
    `;
    const result = transformForClient(input, "test.tsx");

    expect(result.removedServerCode).toBe(true);
    // queries was loader-only → must be DCE'd.
    expect(result.code).not.toContain("queries");
    // The type-only import is harmless to leave in place — Bun.build erases it.
    expect(result.code).not.toMatch(LOADER_PROPERTY_RE);
  });

  test("returns .d.ts files unchanged (passthrough)", () => {
    const input = "export declare function loader(): Promise<unknown>;";
    const result = transformForClient(input, "types.d.ts");

    expect(result.removedServerCode).toBe(false);
    expect(result.code).toBe(input);
  });

  test("import used only in a type annotation is eliminated after loader removal", () => {
    // Regression: before the fix, `UserModel` in `: { user: UserModel }` was
    // counted as a runtime reference because `collectReferencedNames` walked
    // into TSTypeAnnotation nodes. After loader removal the entire import from
    // "./db" had only type-position uses and should be DCE'd.
    const input = `
      import { getUser, UserModel } from "./db";
      export default page({
        loader: async () => ({ user: getUser() }),
        component: ({ user }: { user: UserModel }) => null,
      });
    `;
    const result = transformForClient(input, "test.tsx");

    expect(result.removedServerCode).toBe(true);
    // Both getUser (loader-only) and UserModel (type-annotation-only) are gone.
    expect(result.code).not.toMatch(IMPORT_DB_RE);
  });

  test("import used at runtime survives even when also referenced in a type annotation", () => {
    const input = `
      import { createUser, UserModel } from "./db";
      export default page({
        loader: async () => ({}),
        component: (_: { model: UserModel }) => { createUser(); return null; },
      });
    `;
    const result = transformForClient(input, "test.tsx");

    // createUser is a genuine runtime reference → import must survive.
    expect(result.code).toContain("createUser");
    expect(result.code).toMatch(IMPORT_DB_RE);
  });

  test("interface declaration does not keep its name as a runtime reference", () => {
    // `interface Opts { … }` is type-level; the identifier `Opts` must not be
    // treated as a runtime reference that keeps same-named imports alive.
    const input = `
      import { Opts } from "./db";
      interface LocalOpts { x: number }
      export default page({
        loader: async () => ({}),
        component: (props: LocalOpts) => null,
      });
    `;
    const result = transformForClient(input, "test.tsx");

    // Opts import is unreferenced at runtime → must be removed.
    expect(result.code).not.toMatch(IMPORT_DB_RE);
  });

  test("type alias declaration does not keep its referenced names as runtime references", () => {
    const input = `
      import { DbUser } from "./db";
      type UserAlias = DbUser;
      export default page({
        loader: async () => ({}),
        component: () => null,
      });
    `;
    const result = transformForClient(input, "test.tsx");

    // DbUser only appears inside a type alias → not a runtime reference.
    expect(result.code).not.toMatch(IMPORT_DB_RE);
  });

  test("generic type parameter instantiation does not keep type args as runtime refs", () => {
    const input = `
      import { Config } from "./db";
      import { queries } from "../../db";
      export const route = createRoute<Config>({
        loader: () => ({ posts: queries.getPosts.all() }),
        mode: "ssr",
      });
    `;
    const result = transformForClient(input, "test.tsx");

    expect(result.removedServerCode).toBe(true);
    // Config was only used as a generic type arg — not a runtime reference.
    expect(result.code).not.toContain('from "./db"');
  });
});
