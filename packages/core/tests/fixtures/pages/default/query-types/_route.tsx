import { t } from "elysia";
import { createRoute } from "../../../../../src/client";
import { route as rootRoute } from "../root";

export const route = createRoute({
  parent: rootRoute,
  query: t.Object({
    active: t.Boolean(),
    filter: t.Optional(t.Object({ category: t.String() })),
    page: t.Number(),
    tags: t.Optional(t.Array(t.String())),
  }),
});
