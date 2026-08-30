import { defineRoute } from "@teyik0/furin";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ parent: parentRoute })
  .loader(async () => ({ pageData: "from-page" }))
  .page(({ data: { layoutData, pageData } }) => (
    <div data-layout={String(layoutData)} data-page={String(pageData)} data-testid="loader-page">
      Loader Page
    </div>
  ));
