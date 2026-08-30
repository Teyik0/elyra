import { defineRoute } from "@teyik0/furin";
export const route = defineRoute().layout(({ children }) => (
  <div data-testid="root-layout">{children}</div>
));
