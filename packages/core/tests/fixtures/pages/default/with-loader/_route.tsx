import { createRoute } from "../../../../../src/client";
import { route as rootRoute } from "../root";

export const route = createRoute({
  layout: ({ children, layoutData }) => (
    <div data-layout={String(layoutData)} data-testid="loader-layout">
      {children}
    </div>
  ),
  loader: ({ request, headers, cookie, path, set }) => {
    set.headers["x-loader-ran"] = "true";
    return {
      cookieValue: cookie.test?.value as string | undefined,
      currentPath: path,
      hasHeaders: !!headers,
      layoutData: "from-layout",
      requestUrl: request.url,
    };
  },
  parent: rootRoute,
});
