import { createRoute } from "../../../../../src/client";
import { route as nestedRoute } from "../_route";

export const route = createRoute({
  layout: ({ children }) => <div data-testid="deep-layout">{children}</div>,
  parent: nestedRoute,
});
