import { t } from "elysia";
import { createRoute } from "../../../../../src/client";
import { route as rootRoute } from "../../root";

export const route = createRoute({
  parent: rootRoute,
  params: t.Object({ id: t.String() }),
});
