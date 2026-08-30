import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../root";

export const route = defineRoute()
  .config({ parent: rootRoute })
  .layout(({ children }) => <div data-testid="nested-layout">{children}</div>);
