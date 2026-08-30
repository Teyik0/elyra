import { defineRoute } from "@teyik0/furin";
import { home } from "../shared.ts";

export const route = defineRoute()
  .config({ mode: "ssg" })
  .loader(() => ({ home }))
  .page(({ data }) => String(data.home));
