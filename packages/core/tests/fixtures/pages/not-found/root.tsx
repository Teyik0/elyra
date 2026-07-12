import type { ReactNode } from "react";
import { createRoute } from "../../../../src/client";

export const route = createRoute({
  layout: ({ children }: { children: ReactNode | undefined }) => (
    <div data-testid="root-layout">{children}</div>
  ),
});
