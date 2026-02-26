import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { createVitePlugin, HMR_PATH, shouldHandleByVite } from "../../src/vite";

const TMP = join(tmpdir(), `elysion-vite-middleware-test-${process.pid}`);

describe("shouldHandleByVite", () => {
  test("routes Vite internal paths", () => {
    expect(shouldHandleByVite("/@vite/client")).toBe(true);
    expect(shouldHandleByVite("/@fs/home/user/app/src/main.tsx")).toBe(true);
    expect(shouldHandleByVite("/@id/virtual:elysion-routes")).toBe(true);
    expect(shouldHandleByVite("/node_modules/.vite/deps/react.js")).toBe(true);
  });

  test("routes source files", () => {
    expect(shouldHandleByVite("/src/pages/index.tsx")).toBe(true);
    expect(shouldHandleByVite("/src/main.ts")).toBe(true);
    expect(shouldHandleByVite("/src/styles.css")).toBe(true);
  });

  test("routes by extension", () => {
    expect(shouldHandleByVite("/app.tsx")).toBe(true);
    expect(shouldHandleByVite("/utils.ts")).toBe(true);
    expect(shouldHandleByVite("/component.jsx")).toBe(true);
    expect(shouldHandleByVite("/helpers.js")).toBe(true);
    expect(shouldHandleByVite("/styles.css")).toBe(true);
    expect(shouldHandleByVite("/index.html")).toBe(true);
  });

  test("does not route app pages", () => {
    expect(shouldHandleByVite("/dashboard")).toBe(false);
    expect(shouldHandleByVite("/blog/hello-world")).toBe(false);
    expect(shouldHandleByVite("/api/users")).toBe(false);
    expect(shouldHandleByVite("/")).toBe(false);
  });
});

describe("Vite Middleware", () => {
  const PAGES_DIR = join(TMP, "pages");
  let server: { stop: () => void; url: string; wsUrl: string };

  beforeAll(async () => {
    // Minimal project: just an empty pages dir (elysionPlugin handles empty dirs gracefully)
    mkdirSync(PAGES_DIR, { recursive: true });

    // A simple HTML entry for Vite to serve
    writeFileSync(
      join(TMP, "index.html"),
      `<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>`
    );

    const app = new Elysia().use(await createVitePlugin(PAGES_DIR)).listen(0);

    server = {
      url: `http://localhost:${app.server?.port}`,
      stop: () => app.stop(),
      wsUrl: `ws://localhost:${app.server?.port}`,
    };
  });

  afterAll(() => {
    server.stop();
    rmSync(TMP, { recursive: true, force: true });
  });

  test("serves /@vite/client with JavaScript content-type", async () => {
    const res = await fetch(`${server.url}/@vite/client`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");

    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    // Vite's client script creates the HMR WebSocket connection
    expect(body).toContain("WebSocket");
  });

  test("serves /@vite/client referencing the HMR path", async () => {
    const res = await fetch(`${server.url}/@vite/client`);
    const body = await res.text();

    // The client script should reference our HMR_PATH (/__vite_hmr)
    expect(body).toContain(HMR_PATH);
  });

  test("returns 404 for unknown non-Vite paths", async () => {
    const res = await fetch(`${server.url}/some-unknown-vite-path.js`);
    // Vite didn't handle it → next() called → 404
    expect(res.status).toBe(404);
  });
});
