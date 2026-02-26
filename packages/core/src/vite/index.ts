import { Elysia } from "elysia";
import { toReqRes } from "fetch-to-node";
import { createServer as createViteServer } from "vite";
import { elysionPlugin } from "./plugin";

// Path the browser uses to connect for HMR.
// Vite's /@vite/client will be configured to use this path via hmr.path.
const HMR_PATH = "/__vite_hmr";

// Internal port where Vite opens its standalone wsHttpServer (via node:http,
// which Bun supports natively). Never exposed externally.
const HMR_INTERNAL_PORT = 24678;

// Per-connection state for the WebSocket proxy.
// WeakMap so entries are GC'd when ws objects are collected.
type WsState = { upstream: WebSocket | null; pending: (string | ArrayBuffer)[] };
const wsStates = new WeakMap<object, WsState>();

export async function createVitePlugin(app: Elysia, pagesDir: string) {
  const vite = await createViteServer({
    plugins: [elysionPlugin({ pagesDir })],
    server: {
      middlewareMode: true,
      hmr: {
        // Do NOT pass `server: app.server` — Bun's Server ≠ Node http.Server.
        // Without `server`, Vite creates its own wsHttpServer via node:http
        // (Bun implements node:http natively — no compat mode needed).
        port: HMR_INTERNAL_PORT,
        // Tell /@vite/client to open ws://localhost:3000/__vite_hmr.
        // Bun's .ws() handler proxies that to ws://localhost:24678.
        clientPort: 3000,
        path: HMR_PATH,
      },
    },
    appType: "custom",
  });

  return new Elysia()
    .decorate("vite", vite)

    // ── HTTP bridge ──────────────────────────────────────────────────────────
    // Vite-managed paths (assets, source files, /@vite/*, /@fs/*, etc.)
    // are forwarded through Vite's Connect middleware stack.
    // fetch-to-node v2.x returns a `response` Promise that resolves when
    // the Node ServerResponse calls res.end() — that is our Fetch Response.
    .onRequest(async ({ request }) => {
      const { pathname } = new URL(request.url);
      if (shouldHandleByVite(pathname)) {
        const { req, res, response } = toReqRes(request);
        vite.middlewares(req, res, () => {
          // next() was called — Vite didn't handle this path.
          res.writeHead(404);
          res.end();
        });
        return response;
      }
    })

    // ── WebSocket proxy ───────────────────────────────────────────────────────
    // Intercepts Vite HMR connections and proxies them to Vite's internal
    // wsHttpServer on HMR_INTERNAL_PORT.
    //
    // Why no token validation issues:
    //   Vite's shouldHandle() only checks the CSRF token when Origin header is
    //   present. Our server-side upstream connection has no Origin header, so
    //   Vite skips the check and accepts the connection unconditionally.
    .ws(HMR_PATH, {
      open(ws) {
        const state: WsState = { upstream: null, pending: [] };
        wsStates.set(ws, state);

        const upstream = new WebSocket(`ws://localhost:${HMR_INTERNAL_PORT}`);
        state.upstream = upstream;

        upstream.addEventListener("open", () => {
          for (const msg of state.pending) upstream.send(msg);
          state.pending = [];
        });

        upstream.addEventListener("message", ({ data }) => {
          ws.send(data as string | ArrayBuffer);
        });

        upstream.addEventListener("close", () => ws.close());
        upstream.addEventListener("error", () => ws.close());
      },

      message(ws, message) {
        const state = wsStates.get(ws);
        if (!state) return;
        const { upstream } = state;
        if (!upstream) return;
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(message as string | ArrayBuffer);
        } else {
          state.pending.push(message as string | ArrayBuffer);
        }
      },

      close(ws) {
        const state = wsStates.get(ws);
        if (state?.upstream && state.upstream.readyState !== WebSocket.CLOSED) {
          state.upstream.close();
        }
        wsStates.delete(ws);
      },
    });
}

function shouldHandleByVite(pathname: string): boolean {
  return (
    pathname.startsWith("/@vite/") ||
    pathname.startsWith("/@fs/") ||
    pathname.startsWith("/@id/") ||
    pathname.startsWith("/node_modules/.vite/") ||
    pathname.startsWith("/src/") ||
    pathname.endsWith(".tsx") ||
    pathname.endsWith(".ts") ||
    pathname.endsWith(".jsx") ||
    pathname.endsWith(".js") ||
    pathname.endsWith(".css") ||
    pathname.endsWith(".html")
  );
}
