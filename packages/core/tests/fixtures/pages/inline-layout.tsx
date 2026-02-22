import { createRoute } from "../../../src/client";
import { route as rootRoute } from "./root";

const inlineRoute = createRoute({
  parent: rootRoute,
  layout: ({ children }) => <div data-testid="inline-layout">{children}</div>,
});

export default inlineRoute.page({
  component: () => <div data-testid="inline-page">Inline Layout Page</div>,
});
