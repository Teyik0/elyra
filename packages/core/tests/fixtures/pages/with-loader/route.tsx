import { createRoute } from "../../../../src/client";
import { route as rootRoute } from "../root";

export const route = createRoute({
  parent: rootRoute,
  loader: async () => ({ layoutData: "from-layout" }),
  layout: ({ children, layoutData }) => (
    <div data-layout={String(layoutData)} data-testid="loader-layout">
      {children}
    </div>
  ),
});
