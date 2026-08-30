import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ parent: rootRoute })
  .page(() => <main>Home page</main>);
