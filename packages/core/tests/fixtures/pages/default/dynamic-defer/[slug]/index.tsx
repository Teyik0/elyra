import { defineRoute } from "@teyik0/furin";
import { defer } from "../../../../../../src/client";
import { paramsSchema, route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ params: paramsSchema, parent: parentRoute })
  .loader(({ params }) =>
    defer({
      post: Promise.resolve({ title: `Post for ${String(params.slug)}` }),
      slug: String(params.slug),
    })
  )
  .page(({ data: { slug } }) => <div data-testid="dynamic-defer-page">{slug}</div>);
