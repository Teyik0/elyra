import { defineRoute } from "@teyik0/furin";
import { home } from "../shared.ts";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssg" })
  .loader(() => ({ home }))
  .page(({ data }) => String(data.home));
