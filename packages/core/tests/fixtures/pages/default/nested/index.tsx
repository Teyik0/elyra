import { defineRoute } from "@teyik0/furin";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ parent: parentRoute })
  .page(() => <div data-testid="nested-page">Nested Page</div>);
