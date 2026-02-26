import { Elysia } from "elysia";
import { toReqRes } from "fetch-to-node";

export async function createVitePlugin(app: Elysia) {
  const vite = await import("vite").then((vite) => {
    return vite.createServer({
      server: {
        hmr: {
          server: app.server,
          clientPort: 3000,
        },
        clientPort: 3000,
        middlewareMode: true,
      },
      appType: "custom",
    });
  });

  return new Elysia().decorate("vite", vite).onRequest(({ request, status }) => {
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (shouldHandleByVite(pathname)) {
      const { req, res } = toReqRes(request);
      return vite.middlewares(req, res, () => status("Not Found"));
    }
  });
}

function shouldHandleByVite(pathname: string): boolean {
  if (pathname.startsWith("/@vite/")) {
    return true;
  }
  if (pathname.startsWith("/src/")) {
    return true;
  }
  if (pathname.startsWith("/node_modules/")) {
    return true;
  }
  if (pathname === "/") {
    return true;
  }
  if (pathname.endsWith(".html")) {
    return true;
  }
  if (pathname.endsWith(".tsx") || pathname.endsWith(".ts")) {
    return true;
  }
  if (pathname.endsWith(".jsx") || pathname.endsWith(".js")) {
    return true;
  }
  if (pathname.endsWith(".css")) {
    return true;
  }

  return false;
}
