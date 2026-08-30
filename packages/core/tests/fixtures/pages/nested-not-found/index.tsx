import { defineRoute } from "@teyik0/furin";
import { route as parentRoute } from "./root";

export const route = defineRoute()
  .config({ parent: parentRoute })
  .page(() => <div data-testid="home">Home</div>);
