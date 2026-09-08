/**
 * Local preview server for the static export.
 *
 * Mirrors GitHub Pages behaviour:
 *   - serves dist/ mounted at /furin/
 *   - unknown paths fall back to dist/404.html (the SPA shell)
 *   - navigating to / redirects to /furin/
 *
 * Usage: bun run preview:static
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

interface StaticPreviewOptions {
  basePath: string;
  distDir: string;
  port: number;
}

export function startStaticPreview({ basePath, distDir, port }: StaticPreviewOptions) {
  const faviconPath = join(distDir, "favicon.ico");
  const notFoundPath = join(distDir, "404.html");

  function notFound(): Response {
    return new Response(Bun.file(notFoundPath), { status: 404 });
  }

  return Bun.serve({
    routes: {
      [basePath]: Bun.file(join(distDir, "index.html")),
      [`${basePath}/_client/*`]: { dir: join(distDir, "_client") },
      "/favicon.ico": existsSync(faviconPath) ? Bun.file(faviconPath) : notFound(),
      "/": (request) => Response.redirect(new URL(`${basePath}/`, request.url), 302),
    },
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (!pathname.startsWith(`${basePath}/`)) {
        return notFound();
      }

      const logicalPath = pathname.slice(basePath.length);
      const exactFile = Bun.file(join(distDir, logicalPath));
      if (!logicalPath.endsWith("/") && (await exactFile.exists())) {
        return new Response(exactFile);
      }

      const indexFile = Bun.file(join(distDir, logicalPath, "index.html"));
      if (await indexFile.exists()) {
        return new Response(indexFile);
      }

      return notFound();
    },
    port,
  });
}

if (import.meta.main) {
  const distDir = join(import.meta.dir, "../dist");
  const basePath = "/furin";
  const port = 3012;
  startStaticPreview({ basePath, distDir, port });

  console.log("\x1b[32m◆\x1b[0m Preview server ready");
  console.log(`  Local:  http://localhost:${port}${basePath}/`);
  console.log(`  Serves: ${distDir}`);
  console.log("  Press Ctrl+C to stop\n");
}
