import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ mode: "ssr", parent: rootRoute })
  .page(() => <div data-testid="ssr-page">SSR Page</div>);
