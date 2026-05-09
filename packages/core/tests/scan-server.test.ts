import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { scanFurinInstances } from "../src/build/scan-server";

// Helpers — write a temp file, scan it, clean up
async function withTmpFile(content: string, fn: (path: string) => void): Promise<void> {
  const path = join(
    import.meta.dir,
    `_scan-tmp-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.ts`
  );
  await Bun.write(path, content);
  try {
    fn(path);
  } finally {
    rmSync(path, { force: true });
  }
}

describe("scanFurinInstances", () => {
  test("detects a single furin() with a string literal pagesDir", async () => {
    await withTmpFile(
      `
import { furin } from "furin";
import Elysia from "elysia";
new Elysia().use(furin({ pagesDir: "./src/pages" })).listen(3000);
`,
      (path) => {
        const result = scanFurinInstances(path);
        expect(result).toEqual(["./src/pages"]);
      }
    );
  });

  test("detects multiple furin() instances with different pageDirs", async () => {
    await withTmpFile(
      `
import { furin } from "furin";
import Elysia from "elysia";
new Elysia()
  .use(furin({ pagesDir: "./src/pages/public" }))
  .use(furin({ pagesDir: "./src/pages/admin" }))
  .listen(3000);
`,
      (path) => {
        const result = scanFurinInstances(path);
        expect(result).toEqual(["./src/pages/public", "./src/pages/admin"]);
      }
    );
  });

  test("returns [] for a template literal pagesDir (dynamic path)", async () => {
    await withTmpFile(
      `
import { furin } from "furin";
import Elysia from "elysia";
new Elysia().use(furin({ pagesDir: \`\${import.meta.dir}/pages\` })).listen(3000);
`,
      (path) => {
        const result = scanFurinInstances(path);
        expect(result).toEqual([]);
      }
    );
  });

  test("returns [] for a variable pagesDir (dynamic path)", async () => {
    await withTmpFile(
      `
import { furin } from "furin";
import Elysia from "elysia";
const dir = "./src/pages";
new Elysia().use(furin({ pagesDir: dir })).listen(3000);
`,
      (path) => {
        const result = scanFurinInstances(path);
        expect(result).toEqual([]);
      }
    );
  });

  test("ignores furin() calls without a pagesDir property", async () => {
    await withTmpFile(
      `
import { furin } from "furin";
import Elysia from "elysia";
new Elysia().use(furin({})).listen(3000);
`,
      (path) => {
        const result = scanFurinInstances(path);
        expect(result).toEqual([]);
      }
    );
  });

  test("returns [] when no furin() calls exist", async () => {
    await withTmpFile(
      `
import Elysia from "elysia";
new Elysia().listen(3000);
`,
      (path) => {
        const result = scanFurinInstances(path);
        expect(result).toEqual([]);
      }
    );
  });

  test("returns [] for .d.ts declaration files", async () => {
    const path = join(
      import.meta.dir,
      `_scan-tmp-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.d.ts`
    );
    // .d.ts files contain TS declaration syntax that a JS parser cannot handle.
    await Bun.write(
      path,
      `declare module "furin" { export function furin(opts: { pagesDir: string }): any; }`
    );
    try {
      const result = scanFurinInstances(path);
      expect(result).toEqual([]);
    } finally {
      rmSync(path, { force: true });
    }
  });

  // -------------------------------------------------------------------------
  // TypeScript syntax — yuku-parser handles TS directly, so these cases
  // (which would previously have been stripped by Bun.Transpiler) must now
  // be tolerated end-to-end.
  // -------------------------------------------------------------------------

  test("detects pagesDir when call argument is wrapped in `as FurinOptions`", async () => {
    await withTmpFile(
      `
import { furin } from "furin";
import Elysia from "elysia";
new Elysia().use(furin({ pagesDir: "./src/pages" } as FurinOptions)).listen(3000);
`,
      (path) => {
        const result = scanFurinInstances(path);
        expect(result).toEqual(["./src/pages"]);
      }
    );
  });

  test("detects pagesDir when call argument uses `satisfies FurinOptions`", async () => {
    await withTmpFile(
      `
import { furin } from "furin";
import Elysia from "elysia";
new Elysia()
  .use(furin({ pagesDir: "./src/pages" } satisfies FurinOptions))
  .listen(3000);
`,
      (path) => {
        const result = scanFurinInstances(path);
        expect(result).toEqual(["./src/pages"]);
      }
    );
  });

  test("detects pagesDir alongside surrounding TS type annotations", async () => {
    await withTmpFile(
      `
import { furin } from "furin";
import Elysia from "elysia";
const app: Elysia = new Elysia();
const opts: { pagesDir: string } = { pagesDir: "./src/pages" };
app.use(furin(opts)).listen(3000);
app.use(furin({ pagesDir: "./src/admin" })).listen(3001);
`,
      (path) => {
        // First call uses a variable → ignored; second uses a literal → captured.
        const result = scanFurinInstances(path);
        expect(result).toEqual(["./src/admin"]);
      }
    );
  });
});
