/**
 * HMR WebSocket proxy tests.
 *
 * Verifies that Elysia's .ws(HMR_PATH) correctly proxies connections
 * to Vite's internal wsHttpServer on HMR_INTERNAL_PORT.
 *
 * The proxy is the core fix for running Vite HMR inside Bun without
 * Node compatibility mode: instead of passing `hmr.server: bunServer`
 * (which fails because Bun.Server ≠ Node http.Server), Vite opens its
 * own node:http server on an internal port, and Elysia proxies WebSocket
 * upgrades from the public port to it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { createVitePlugin, HMR_PATH } from "../../src/vite";

const TMP = join(tmpdir(), `elysion-vite-ws-test-${process.pid}`);

describe("HMR WebSocket proxy", () => {
  const PAGES_DIR = join(TMP, "pages");
  let serverUrl: string;
  let stop: () => void;

  beforeAll(async () => {
    mkdirSync(PAGES_DIR, { recursive: true });

    const app = new Elysia().use(await createVitePlugin(PAGES_DIR)).listen(0);

    serverUrl = `ws://localhost:${app.server?.port}`;
    stop = () => app.stop();
  });

  afterAll(() => {
    stop();
    rmSync(TMP, { recursive: true, force: true });
  });

  test("WebSocket upgrade is accepted at HMR_PATH", async () => {
    const ws = new WebSocket(`${serverUrl}${HMR_PATH}`);

    const connected = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      // Timeout after 3s
      setTimeout(() => resolve(false), 3000);
    });

    expect(connected).toBe(true);
    ws.close();
  });

  test("Vite sends { type: 'connected' } immediately after handshake", async () => {
    const ws = new WebSocket(`${serverUrl}${HMR_PATH}`);

    const firstMessage = await new Promise<string | null>((resolve) => {
      ws.onmessage = ({ data }) => resolve(data as string);
      ws.onerror = () => resolve(null);
      setTimeout(() => resolve(null), 3000);
    });

    expect(firstMessage).not.toBeNull();

    const parsed = JSON.parse(firstMessage as string) as { type: string };
    // Vite's WS server always sends { type: 'connected' } on new connections
    expect(parsed.type).toBe("connected");

    ws.close();
  });

  test("multiple concurrent HMR connections are proxied independently", async () => {
    const connect = () =>
      new Promise<{ ws: WebSocket; firstMsg: string | null }>((resolve) => {
        const ws = new WebSocket(`${serverUrl}${HMR_PATH}`);
        ws.onmessage = ({ data }) => resolve({ ws, firstMsg: data as string });
        ws.onerror = () => resolve({ ws, firstMsg: null });
        setTimeout(() => resolve({ ws, firstMsg: null }), 3000);
      });

    const [conn1, conn2, conn3] = await Promise.all([connect(), connect(), connect()]);

    for (const { ws, firstMsg } of [conn1, conn2, conn3]) {
      expect(firstMsg).not.toBeNull();
      const parsed = JSON.parse(firstMsg as string) as { type: string };
      expect(parsed.type).toBe("connected");
      ws.close();
    }
  });

  test("WebSocket connection at root path is not intercepted (404 or upgrade refused)", async () => {
    // The proxy only handles HMR_PATH, not all WS connections
    const ws = new WebSocket(`${serverUrl}/`);

    const result = await new Promise<"open" | "error">((resolve) => {
      ws.onopen = () => resolve("open");
      ws.onerror = () => resolve("error");
      setTimeout(() => resolve("error"), 2000);
    });

    // Root path has no WS handler — should not connect as HMR
    // (may error or connect depending on Elysia fallback behavior)
    if (result === "open") {
      // If it opened, it should NOT send a Vite `connected` message
      const msg = await new Promise<string | null>((resolve) => {
        ws.onmessage = ({ data }) => resolve(data as string);
        setTimeout(() => resolve(null), 500);
      });
      expect(msg).toBeNull();
    } else {
      expect(result).toBe("error");
    }

    ws.close();
  });
});
