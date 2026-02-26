/**
 * Determines whether a request path should be handled by Vite's middleware.
 * Extracted into a separate file so it can be imported and tested without
 * loading the full Vite / rolldown-vite package.
 */
export function shouldHandleByVite(pathname: string): boolean {
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
