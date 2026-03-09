import { createRoute } from "elyra/client";

export const route = createRoute({
  layout: ({ children }) => <div data-testid="root-layout">{children}</div>,
});
