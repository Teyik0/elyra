import { createRoute } from "../../../../../src/client";
import { route as rootRoute } from "../root";

export const route = createRoute({
  layout: ({ children }) => <div data-testid="nested-layout">{children}</div>,
  parent: rootRoute,
});
