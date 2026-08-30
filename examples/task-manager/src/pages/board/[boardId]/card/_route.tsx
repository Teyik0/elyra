import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { route as boardRoute } from "../../_route";

export const route = defineRoute()
  .config({
    params: t.Object({
      boardId: t.String(),
      cardId: t.String(),
    }),
    parent: boardRoute,
    tags: ["cards"],
  })
  .layout(({ children }) => children);
