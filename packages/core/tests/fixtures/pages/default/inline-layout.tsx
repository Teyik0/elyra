import { createRoute } from "../../../../src/client";
import { route as rootRoute } from "./root";

const inlineRoute = createRoute({
  layout: ({ children }) => <div data-testid="inline-layout">{children}</div>,
  parent: rootRoute,
});

export default inlineRoute.page({
  component: () => <div data-testid="inline-page">Inline Layout Page</div>,
});
