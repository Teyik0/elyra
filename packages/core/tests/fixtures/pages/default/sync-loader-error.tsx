import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ mode: "ssr", parent: rootRoute })
  .loader(() => {
    throw new Error("synchronous loader failure");
  })
  .page(() => <div>unreachable</div>);
