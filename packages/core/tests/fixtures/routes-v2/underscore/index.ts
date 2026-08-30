import { defineRoute } from "@teyik0/furin";

export const route = defineRoute()
  .loader(() => ({ marker: "underscore-index" }))
  .page(({ data }) => data.marker);
