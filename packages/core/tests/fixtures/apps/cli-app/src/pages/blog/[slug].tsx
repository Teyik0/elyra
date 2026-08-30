import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { route as rootRoute } from "../root";

export const route = defineRoute()
  .config({
    params: t.Object({ slug: t.String() }),
    parent: rootRoute,
    staticParams: () => [{ slug: "hello-world" }],
  })
  .page(() => <article>Blog post page</article>);
