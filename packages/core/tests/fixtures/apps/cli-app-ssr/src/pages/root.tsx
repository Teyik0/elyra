import { defineRootRoute } from "@teyik0/furin";

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => <div data-testid="root-layout">{children}</div>);
