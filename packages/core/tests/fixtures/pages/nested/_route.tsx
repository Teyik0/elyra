import { createRoute } from "../../../../src/client";
import { route as rootRoute } from "../root";

export const route = createRoute({
  parent: rootRoute,
  layout: ({ children }) => <div data-testid="nested-layout">{children}</div>,
});
