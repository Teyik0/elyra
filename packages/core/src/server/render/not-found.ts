import { renderToReadableStream } from "react-dom/server";
import { normalizeHref, toLogical } from "../../client/router/link-utils.ts";
import type { RouterContextValue } from "../../client/router/types.ts";
import { FurinNotFoundError } from "../../shared/not-found.ts";
import { useLogger } from "../context-logger.ts";
import { currentInstance } from "../instance.ts";
import type { RootLayout } from "../router/index.ts";
import { assembleHTML, streamToString } from "./assemble.ts";
import { buildNotFoundElement } from "./element.tsx";
import { generateIndexHtml } from "./shell.ts";
import { withSSRRouterContext } from "./ssr.ts";
import { getProductionTemplate } from "./template.ts";

/**
 * Renders the root-level not-found component into a complete 404 HTML Response.
 * Used by the Elysia `.onError` catch-all when no route matches the request URL.
 */
export async function renderRootNotFound(
  root: RootLayout,
  request: Request | undefined
): Promise<Response> {
  const prodTemplate = getProductionTemplate();
  let template: string;
  if (prodTemplate === null) {
    template = generateIndexHtml();
  } else {
    template = prodTemplate;
  }
  const notFoundError = new FurinNotFoundError(undefined);

  // The request-scope wrap binds the path-resolved instance before this
  // handler runs, so its prefix is the basePath — SSR'd links on the 404
  // page must be physical (prefixed), and currentHref logical, exactly like
  // the regular render pipeline.
  const basePath = currentInstance().prefix;
  const notFoundContext: RouterContextValue = {
    basePath,
    currentHref: request ? normalizeHref(toLogical(new URL(request.url).pathname, basePath)) : "/",
    search: {},
    searchRoutes: [],
    navigate: (_href, _opts) => Promise.resolve(),
    prefetch: (_href, _opts) => {
      /* noop */
    },
    invalidatePrefetch: (_path, _type) => {
      /* noop */
    },
    refresh: (_opts) => Promise.resolve(),
    isNavigating: false,
    defaultPreload: "intent",
    defaultPreloadDelay: 50,
    defaultPreloadStaleTime: 30_000,
  };

  useLogger().set({
    furin: {
      render: "not-found",
      action: "catch_all",
      path: request ? new URL(request.url).pathname : "/",
    },
  });

  let reactStream: Awaited<ReturnType<typeof renderToReadableStream>>;
  try {
    reactStream = await renderToReadableStream(
      withSSRRouterContext(buildNotFoundElement(root.notFound, notFoundError), notFoundContext)
    );
  } catch (renderError) {
    // The user's not-found component itself threw. Fall back to the built-in
    // screen, but surface the failure — silently swallowing it hides a broken
    // 404 page from logs and drains.
    useLogger().set({
      furin: {
        render: "not-found",
        action: "component_render_failed",
        error: renderError instanceof Error ? renderError.message : String(renderError),
      },
    });
    reactStream = await renderToReadableStream(
      withSSRRouterContext(buildNotFoundElement(undefined, notFoundError), notFoundContext)
    );
  }
  await reactStream.allReady;
  const reactHtml = await streamToString(reactStream);
  const html = assembleHTML(template, "", reactHtml, { __furinStatus: 404 });

  return new Response(html, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
