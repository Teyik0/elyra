import { dirname, resolve } from "node:path";
import { Elysia, t } from "elysia";
import { getCachedCss, getCssConfig, invalidateCssCache } from "../css";
import { REFRESH_SETUP_CODE } from "./refresh-setup";
import { getHmrClients, getTransformedModule, setupHmrWatcher } from "./watcher";

export function createHmrPlugin(pagesDir: string, cssInputPath?: string) {
  setupHmrWatcher(pagesDir, cssInputPath);

  const srcDir = dirname(pagesDir);

  const hmrPlugin = new Elysia({ name: "elysion-hmr" })
    .ws("/__elysion/hmr", {
      body: t.Any(),
      open(ws) {
        getHmrClients().add(ws.raw);
        console.log(`[hmr] Client connected (${getHmrClients().size} total)`);
        ws.send(JSON.stringify({ type: "connected" }));
      },
      close(ws) {
        getHmrClients().delete(ws.raw);
        console.log(`[hmr] Client disconnected (${getHmrClients().size} remaining)`);
      },
      message(_ws, message) {
        console.log("[hmr] Client message:", message);
      },
    })
    .get("/__refresh-setup.js", ({ set }) => {
      set.headers["content-type"] = "application/javascript";
      set.headers["cache-control"] = "no-cache";
      return REFRESH_SETUP_CODE;
    })
    .get("/_modules/src/*", async ({ path, set, status }) => {
      const relativePath = decodeURIComponent(path.replace("/_modules/src/", ""));
      let fullPath = resolve(srcDir, relativePath);

      if (!fullPath.startsWith(srcDir)) {
        return status("Forbidden", `File does not exist at: ${fullPath}`);
      }

      // Try with extensions if file doesn't exist
      const extensions = [".tsx", ".ts", ".jsx", ".js"];
      const file = Bun.file(fullPath);
      if (!(await file.exists())) {
        for (const ext of extensions) {
          const pathWithExt = fullPath + ext;
          const fileWithExt = Bun.file(pathWithExt);
          if (await fileWithExt.exists()) {
            fullPath = pathWithExt;
            break;
          }
        }
      }

      set.headers["content-type"] = "application/javascript";
      set.headers["cache-control"] = "no-cache";
      try {
        const code = await getTransformedModule(fullPath, srcDir, pagesDir);
        return status(200, code);
      } catch (error) {
        console.error("[hmr] Module transform error:", error);
        return status(500, `// Error: ${error}`);
      }
    })
    .get("/__elysion/css", async ({ set, status }) => {
      const config = getCssConfig();
      set.headers["content-type"] = "text/css";
      if (!config) {
        return status("Not Found", "CSS Not Configured");
      }

      set.headers["cache-control"] = "no-cache";

      try {
        // Invalidate cache to ensure fresh CSS
        const absolutePath = resolve(process.cwd(), config.input);
        invalidateCssCache(absolutePath);

        const result = await getCachedCss(process.cwd());
        return result?.code;
      } catch (error: unknown) {
        console.error("[hmr] CSS processing error:", error);
        return status("Internal Server Error", `CSS Error: ${error}`);
      }
    });

  return hmrPlugin;
}
