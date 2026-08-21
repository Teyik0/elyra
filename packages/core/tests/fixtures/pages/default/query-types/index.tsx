import { route } from "./_route";

export default route.page({
  component: ({ query }) => <div data-testid="query-types-page">{JSON.stringify(query)}</div>,
  loader: ({ query }) => ({
    queryFromLoader: query,
  }),
});
