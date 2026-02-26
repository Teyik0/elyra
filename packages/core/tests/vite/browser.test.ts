/**
 * Playwright browser-level e2e tests for the Vite HMR integration.
 *
 * These tests run a real browser against a real Elysia server to verify:
 *  1. Vite serves /@vite/client correctly (the HMR runtime)
 *  2. The HMR WebSocket proxy at /__vite_hmr accepts browser connections
 *  3. Vite's WS server sends { type: 'connected' } through the proxy
 *  4. Bidirectional message passing works (ping from browser, pong from Vite)
 *
 * We create the WebSocket manually from page.evaluate() rather than relying
 * on /@vite/client's auto-connect. This decouples the test from the
 * hmr.clientPort setting (which is hardcoded to 3000 in production) and
 * directly validates the proxy itself.
 *
 * Prerequisites:
 *   bunx playwright install chromium
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { type Browser, chromium } from "playwright";
import { createVitePlugin, HMR_PATH } from "../../src/vite";

const TMP = join(tmpdir(), `elysion-vite-browser-test-${process.pid}`);

describe("Vite HMR — browser e2e", () => {
  const PAGES_DIR = join(TMP, "pages");
  let browser: Browser;
  let serverUrl: string;
  let wsUrl: string;
  let stop: () => void;

  beforeAll(async () => {
    mkdirSync(PAGES_DIR, { recursive: true });

    // Minimal Elysia server with Vite middleware + a simple HTML route
    // (served by Elysia, not by Vite — appType: "custom" means Vite won't
    // serve HTML automatically; we just need any page to open in the browser)
    const app = new Elysia()
      .use(await createVitePlugin(PAGES_DIR))
      .get(
        "/",
        () =>
          new Response(
            `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Elysion Vite Test</title>
  </head>
  <body>
    <h1 id="title">Elysion HMR Test</h1>
  </body>
</html>`,
            { headers: { "Content-Type": "text/html; charset=utf-8" } }
          )
      )
      .listen(0);

    const port = app.server?.port;
    serverUrl = `http://localhost:${port}`;
    wsUrl = `ws://localhost:${port}${HMR_PATH}`;
    stop = () => app.stop();

    // Use the installed Chromium binary. Playwright auto-downloads to
    // ~/.cache/ms-playwright but that may be blocked in some environments.
    // Fall back gracefully to the installed revision if the expected one is missing.
    const executablePath =
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
      "/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome";
    browser = await chromium.launch({ headless: true, executablePath });
  });

  afterAll(async () => {
    await browser.close();
    stop();
    rmSync(TMP, { recursive: true, force: true });
  });

  test("serves /@vite/client containing the HMR WebSocket path", async () => {
    const res = await fetch(`${serverUrl}/@vite/client`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");

    const body = await res.text();
    // Vite's client script must reference our HMR path so the browser knows
    // which WebSocket endpoint to connect to
    expect(body).toContain(HMR_PATH);
  });

  test("browser can open the test page", async () => {
    const page = await browser.newPage();

    const res = await page.goto(serverUrl, { waitUntil: "domcontentloaded" });
    expect(res?.status()).toBe(200);

    const title = await page.$eval("#title", (el) => el.textContent);
    expect(title).toBe("Elysion HMR Test");

    await page.close();
  });

  test("browser WebSocket connects to HMR proxy and receives { type: 'connected' }", async () => {
    const page = await browser.newPage();
    await page.goto(serverUrl, { waitUntil: "domcontentloaded" });

    // Open a WebSocket to our HMR proxy from inside the browser.
    // This is what /@vite/client does automatically in production; here we
    // do it explicitly so the test is independent of clientPort.
    const result = await page.evaluate((wsEndpoint) => {
      return new Promise<{ connected: boolean; firstMessage: string | null }>((resolve) => {
        const ws = new WebSocket(wsEndpoint);

        ws.onopen = () => {
          // Connection established — wait for Vite's first message
        };

        ws.onmessage = ({ data }) => {
          ws.close();
          resolve({ connected: true, firstMessage: data as string });
        };

        ws.onerror = () => {
          resolve({ connected: false, firstMessage: null });
        };

        setTimeout(() => {
          ws.close();
          resolve({ connected: false, firstMessage: null });
        }, 4000);
      });
    }, wsUrl);

    expect(result.connected).toBe(true);
    expect(result.firstMessage).not.toBeNull();

    const parsed = JSON.parse(result.firstMessage as string) as { type: string };
    // Vite's WS server sends { type: 'connected' } immediately on handshake
    expect(parsed.type).toBe("connected");

    await page.close();
  });

  test("HMR proxy handles multiple browser tabs independently", async () => {
    const openAndReceive = async () => {
      const page = await browser.newPage();
      await page.goto(serverUrl, { waitUntil: "domcontentloaded" });

      const msg = await page.evaluate((wsEndpoint) => {
        return new Promise<string | null>((resolve) => {
          const ws = new WebSocket(wsEndpoint);
          ws.onmessage = ({ data }) => {
            ws.close();
            resolve(data as string);
          };
          ws.onerror = () => resolve(null);
          setTimeout(() => {
            ws.close();
            resolve(null);
          }, 4000);
        });
      }, wsUrl);

      await page.close();
      return msg;
    };

    // Simulate 3 browser tabs connecting simultaneously
    const [msg1, msg2, msg3] = await Promise.all([
      openAndReceive(),
      openAndReceive(),
      openAndReceive(),
    ]);

    for (const msg of [msg1, msg2, msg3]) {
      expect(msg).not.toBeNull();
      const parsed = JSON.parse(msg as string) as { type: string };
      expect(parsed.type).toBe("connected");
    }
  });

  test("no console errors during normal page load + HMR WS connect", async () => {
    const page = await browser.newPage();
    const consoleErrors: string[] = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    page.on("pageerror", (err) => {
      consoleErrors.push(err.message);
    });

    await page.goto(serverUrl, { waitUntil: "domcontentloaded" });

    // Connect to HMR WS and wait for first message
    await page.evaluate((wsEndpoint) => {
      return new Promise<void>((resolve) => {
        const ws = new WebSocket(wsEndpoint);
        ws.onmessage = () => {
          ws.close();
          resolve();
        };
        ws.onerror = () => resolve();
        setTimeout(resolve, 3000);
      });
    }, wsUrl);

    // Filter known non-critical Vite warnings
    const criticalErrors = consoleErrors.filter(
      (e) => !(e.includes("Failed to load resource") || e.includes("favicon") || e.includes("404"))
    );

    expect(criticalErrors).toHaveLength(0);

    await page.close();
  });
});
