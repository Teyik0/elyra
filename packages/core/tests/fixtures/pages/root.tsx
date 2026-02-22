import { createRoute } from "../../../src/client";

export const route = createRoute({
  layout: ({ children }) => (
    <html lang="en">
      <body data-testid="root-layout">{children}</body>
    </html>
  ),
});
