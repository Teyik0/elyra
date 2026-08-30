import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { route as rootRoute } from "../../root";

export const paramsSchema = t.Object({ slug: t.String() });

export const route = defineRoute()
  .config({ params: paramsSchema, parent: rootRoute })
  .layout(({ children }) => children);
