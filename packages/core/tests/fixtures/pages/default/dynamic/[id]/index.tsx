import { defineRoute } from "@teyik0/furin";
import { paramsSchema, route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ params: paramsSchema, parent: parentRoute })
  .loader(() => ({ pageData: "from-dynamic" }))
  .page(({ data: { pageData }, params }) => (
    <div data-id={String(params.id)} data-page={String(pageData)} data-testid="dynamic-page">
      Dynamic Page: {params.id}
    </div>
  ));
