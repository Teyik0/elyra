import { defineRoute } from "@teyik0/furin";

export const route = defineRoute()
  .loader(() => ({ user: "teyik" }))
  .layout(({ children }) => children);
