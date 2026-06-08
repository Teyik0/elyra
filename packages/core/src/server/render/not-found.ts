import { renderToReadableStream } from "react-dom/server";
import { normalizeHref, type RouterContextValue } from "../../client/router/index.ts";
import { FurinNotFoundError } from "../../shared/not-found.ts";
import { useLogger } from "../context-logger.ts";
import type { RootLayout } from "../router/index.ts";
import { IS_DEV } from "../runtime-env.ts";
import { assembleHTML, streamToString } from "./assemble.ts";
import { buildNotFoundElement } from "./element.tsx";
import { generateIndexHtml } from "./shell.ts";
import { withSSRRouterContext } from "./ssr.ts";
import { getDevTemplate, getProductionTemplate } from "./template.ts";

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
  if (prodTemplate !== null) {
    template = prodTemplate;
  } else if (IS_DEV && request !== undefined) {
    try {
      template = await getDevTemplate(new URL(request.url).origin);
    } catch (devTemplateErr) {
      useLogger().set({
        furin: {
          render: "not-found",
          action: "dev_template_fallback",
          error: devTemplateErr instanceof Error ? devTemplateErr.message : String(devTemplateErr),
        },
      });
      template = generateIndexHtml();
    }
  } else {
    template = generateIndexHtml();
  }
  const notFoundError = new FurinNotFoundError(undefined);

  const notFoundContext: RouterContextValue = {
    basePath: "",
    currentHref: request ? normalizeHref(new URL(request.url).pathname) : "/",
    navigate: () => Promise.resolve(),
    prefetch: () => {
      /* noop */
    },
    invalidatePrefetch: () => {
      /* noop */
    },
    refresh: () => Promise.resolve(),
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
