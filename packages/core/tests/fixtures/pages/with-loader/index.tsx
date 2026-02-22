import { route } from "./route";

export default route.page({
  loader: async ({ layoutData }) => ({ pageData: "from-page", layoutData }),
  component: ({ layoutData, pageData }) => (
    <div data-layout={String(layoutData)} data-page={String(pageData)} data-testid="loader-page">
      Loader Page
    </div>
  ),
});
