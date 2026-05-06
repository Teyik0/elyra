import { route } from "./_route";

export default route.page({
  loader: () => ({ pageData: "from-dynamic" }),
  component: ({ pageData, params }) => (
    <div data-id={String(params.id)} data-page={String(pageData)} data-testid="dynamic-page">
      Dynamic Page: {params.id}
    </div>
  ),
});
