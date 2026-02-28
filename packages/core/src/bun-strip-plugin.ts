import { plugin } from "bun";
import { transformForClient } from "./transform-client";

const TS_FILE_FILTER = /\.(tsx|ts)$/;
const ELYSIA_FILTER = /^elysia$/;
const ANY_FILTER = /.*/;
const REACT_IMPORT_FILTER = /import\s+React\b/;

// Persisted across bun --hot reloads so we don't re-register the plugin
// on every file-change-triggered re-evaluation of this module.
// Direct access per Bun HMR guidelines (no indirection).
const _hmrData = import.meta.hot?.data as { pluginRegistered?: boolean } | undefined;
if (_hmrData && _hmrData.pluginRegistered === undefined) {
  _hmrData.pluginRegistered = false;
}
import.meta.hot?.dispose((data: { pluginRegistered?: boolean }) => {
  data.pluginRegistered = _hmrData?.pluginRegistered ?? false;
});

// Minimal browser stub for elysia — `t` is only used for schema definitions
// in params/query, which the client never validates at runtime.
const ELYSIA_STUB = `\
export const t = new Proxy({}, { get: () => (...args) => args[0] ?? {} });
export class NotFoundError extends Error { constructor(m) { super(m); this.name = "NotFoundError"; } }
export class ValidationError extends Error { constructor(m) { super(m); this.name = "ValidationError"; } }
export default {};
`;

/**
 * Registers a Bun build plugin (once per process) that:
 *  1. Stubs 'elysia' for the browser with a minimal proxy.
 *  2. Strips server-only code (loader, head) from page files before they are
 *     bundled into the client entry by Bun's native HTML bundler.
 *
 * Must be called before the server module is evaluated so Bun uses the plugin
 * when it processes the HTML entry referenced by the static import.
 */
export function registerBunStripPlugin(pagesDir: string): void {
  if (_hmrData?.pluginRegistered) {
    return;
  }
  if (_hmrData) {
    _hmrData.pluginRegistered = true;
  }

  plugin({
    name: "elysion-strip-server",
    setup(build) {
      // ── elysia browser stub ──────────────────────────────────────────────
      build.onResolve({ filter: ELYSIA_FILTER }, () => ({
        path: "elysia-stub",
        namespace: "elysion-stubs",
      }));

      build.onLoad({ namespace: "elysion-stubs", filter: ANY_FILTER }, () => ({
        contents: ELYSIA_STUB,
        loader: "js",
      }));

      // ── page file stripping ───────────────────────────────────────────────
      build.onLoad({ filter: TS_FILE_FILTER }, async (args) => {
        const { path } = args;

        // Only process files inside the user's pages directory.
        if (path.includes("node_modules") || !path.startsWith(pagesDir)) {
          return undefined;
        }

        const source = await Bun.file(path).text();

        try {
          const result = transformForClient(source, path);
          let code = result.code;

          // transformForClient uses the classic JSX factory (React.createElement),
          // but doesn't add the React import for files that didn't import it
          // explicitly. Add it when needed so React is always in scope.
          if (code.includes("React.createElement") && !REACT_IMPORT_FILTER.test(code)) {
            code = `import React from "react";\n${code}`;
          }

          return { contents: code, loader: "js" };
        } catch (err) {
          console.error(`[elysion] Strip-server transform error for ${path}:`, err);
          return undefined;
        }
      });
    },
  });
}

// ── Dev template helpers ────────────────────────────────────────────────────

/**
 * Lazily fetches the Bun-processed /_bun_entry HTML and caches it.
 *
 * The fetched HTML is used as the SSR template: it contains the
 * content-hashed chunk paths and HMR WebSocket client that Bun injected,
 * plus our <!--ssr-head--> and <!--ssr-outlet--> placeholders which Bun
 * preserves as-is.
 *
 * Must be called from within a request handler (after the server is listening
 * and serve.routes["/_bun_entry"] is registered).
 *
 * @param origin - The server origin, e.g. "http://localhost:3000".
 *                 Derived from ctx.request.url in request handlers.
 */
let _devTemplatePromise: Promise<string> | null = null;

export function getDevTemplate(origin: string): Promise<string> {
  _devTemplatePromise ??= fetch(`${origin}/_bun_entry`)
    .then((r) => {
      if (!r.ok) {
        throw new Error(`/_bun_entry returned ${r.status}`);
      }
      return r.text();
    })
    .catch((err) => {
      _devTemplatePromise = null;
      throw err;
    });
  return _devTemplatePromise;
}

export function resetDevTemplate(): void {
  _devTemplatePromise = null;
}
