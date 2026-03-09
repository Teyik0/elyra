import { createRoute } from "../../../../../src/client";
import { route as nestedRoute } from "../_route";

export const route = createRoute({
  parent: nestedRoute,
  layout: ({ children }) => <div data-testid="deep-layout">{children}</div>,
});
