// biome-ignore-all lint/performance/noAwaitInLoops: integration test polling must wait between retries
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";
import { createTmpApp, removeAppPath, writeAppFile } from "../../support/app-fixtures.ts";
import { getFreePort } from "../../support/hmr.ts";
import { startProcess } from "../../support/process.ts";

/**
 * Integration test for route TOPOLOGY changes while `bun --hot` is running.
 *
 * Contract under test: hot-adding a brand-new `defineRoute` page file must
 * serve the new route without a server restart, and hot-removing it must stop
 * serving it. This complements the content-edit HMR suite
 * (dev-hmr*.integration.test.ts), which covers edits to EXISTING routes.
 *
 * Mechanism: the dev topology watcher (100 ms poll on pagesDir) re-scans on
 * add/remove, regenerates the dev files (`.furin/_hydrate.tsx`,
 * `furin-env.d.ts`), and Bun's soft reload re-runs the entry, recomposing the
 * native Elysia app and the renderer table.
 */

async function pollUntil(
  fn: () => Promise<boolean>,
  maxAttempts: number,
  delayMs: number
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i += 1) {
    if (await fn()) {
      return true;
    }
    await Bun.sleep(delayMs);
  }
  return false;
}

describe.serial("dev route topology — hot add/remove of route files", () => {
  const app = createTmpApp("cli-app");
  let port: number;
  let server: ReturnType<typeof startProcess>;

  // Root layout — minimal marker wrapper.
  writeAppFile(
    app.path,
    "src/pages/root.tsx",
    [
      'import { defineRootRoute } from "@teyik0/furin";',
      "",
      "export const route = defineRootRoute()",
      '  .config({ mode: "ssr" })',
      '  .layout(({ children }) => <div data-root="true">{children}</div>);',
    ].join("\n")
  );

  // Home page — needed so the app boots and / answers.
  writeAppFile(
    app.path,
    "src/pages/index.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { route as rootRoute } from "./root";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "ssg" })',
      "  .page(() => <main>Home</main>);",
    ].join("\n")
  );

  beforeAll(async () => {
    port = await getFreePort();
    server = startProcess(["bun", "--hot", join(app.path, "src/server.ts")], {
      cwd: app.path,
      env: { PORT: String(port) },
    });

    const ready = await pollUntil(
      async () => {
        try {
          const r = await fetch(`http://localhost:${port}/`);
          return r.ok;
        } catch {
          return false;
        }
      },
      80,
      250
    );
    if (!ready) {
      throw new Error(`Server failed to start on port ${port}. stderr:\n${server.getStderr()}`);
    }
  }, 30_000);

  afterAll(() => {
    server?.kill();
    app.cleanup();
  });

  test("baseline — /about is 404 while the file does not exist", async () => {
    const res = await fetch(`http://localhost:${port}/about`);
    expect(res.status).toBe(404);
  });

  test("hot-add — creating pages/about.tsx serves the route without a restart", async () => {
    const logsBefore = server.getStdout() + server.getStderr();
    const listenCountBefore = (logsBefore.match(/listening on/g) ?? []).length;

    writeAppFile(
      app.path,
      "src/pages/about.tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { route as rootRoute } from "./root";',
        "",
        "export const route = defineRoute()",
        '  .config({ layout: rootRoute, mode: "ssg" })',
        '  .loader(() => ({ title: "About page" }))',
        '  .page(({ data }) => <main data-about="v1">{data.title}</main>);',
      ].join("\n")
    );

    let html = "";
    let status = 0;
    const served = await pollUntil(
      async () => {
        try {
          const r = await fetch(`http://localhost:${port}/about`);
          ({ status } = r);
          html = await r.text();
          return r.status === 200 && html.includes('data-about="v1"');
        } catch {
          return false;
        }
      },
      40,
      250
    );

    expect(served).toBe(true);
    expect(status).toBe(200);
    expect(html).toContain('data-about="v1"');

    const dataResponse = await fetch(
      `http://localhost:${port}/_furin/data?path=${encodeURIComponent("/about")}`
    );
    expect(dataResponse.status).toBe(200);
    const { syncData } = await parseDeferredNdjson(
      dataResponse.body ??
        new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      undefined
    );
    expect(syncData.title).toBe("About page");

    const snapshotResponse = await fetch(`http://localhost:${port}/_furin/devtools/snapshot`);
    const snapshot = (await snapshotResponse.json()) as { routes: Array<{ pattern: string }> };
    expect(snapshot.routes.some((route) => route.pattern === "/about")).toBe(true);

    // No server restart must have occurred.
    const logsAfter = server.getStdout() + server.getStderr();
    const listenCountAfter = (logsAfter.match(/listening on/g) ?? []).length;
    expect(listenCountAfter).toBe(listenCountBefore);
  }, 20_000);

  test("hot-remove — deleting pages/about.tsx stops serving the route", async () => {
    removeAppPath(app.path, "src/pages/about.tsx");

    let status = 0;
    const gone = await pollUntil(
      async () => {
        try {
          const r = await fetch(`http://localhost:${port}/about`);
          ({ status } = r);
          return r.status === 404;
        } catch {
          return false;
        }
      },
      40,
      250
    );

    expect(gone).toBe(true);
    expect(status).toBe(404);

    const dataResponse = await fetch(
      `http://localhost:${port}/_furin/data?path=${encodeURIComponent("/about")}`
    );
    expect(dataResponse.status).toBe(404);

    const snapshotResponse = await fetch(`http://localhost:${port}/_furin/devtools/snapshot`);
    const snapshot = (await snapshotResponse.json()) as { routes: Array<{ pattern: string }> };
    expect(snapshot.routes.some((route) => route.pattern === "/about")).toBe(false);
  }, 20_000);

  test("hot-added routes retain schema normalization", async () => {
    writeAppFile(
      app.path,
      "src/pages/items/[id].tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { t } from "elysia";',
        'import { route as rootRoute } from "../root";',
        "",
        "export const route = defineRoute()",
        "  .config({",
        "    layout: rootRoute,",
        '    mode: "ssr",',
        "    params: t.Object({ id: t.Number() }),",
        "    query: t.Object({ page: t.Optional(t.Number({ default: 7 })) }),",
        "  })",
        "  .loader(({ params, query }) => ({",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: emits a route source template literal
        "    detail: `${typeof params.id}:${params.id}:${query.page}`,",
        "  }))",
        '  .page(({ data }) => <main data-item="true">{data.detail}</main>);',
      ].join("\n")
    );

    try {
      let html = "";
      const served = await pollUntil(
        async () => {
          try {
            const response = await fetch(`http://localhost:${port}/items/42`);
            html = await response.text();
            return response.status === 200 && html.includes("number:42:7");
          } catch {
            return false;
          }
        },
        40,
        250
      );

      expect(served).toBe(true);
      expect(html).toContain("number:42:7");
      expect((await fetch(`http://localhost:${port}/items/nope`)).status).toBe(422);
    } finally {
      removeAppPath(app.path, "src/pages/items/[id].tsx");
    }
  }, 20_000);
});
