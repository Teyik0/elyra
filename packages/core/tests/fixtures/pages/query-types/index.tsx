import { route } from "./_route";

export default route.page({
  loader: ({ query }) => ({
    queryFromLoader: query,
  }),
  component: ({ query }) => <div data-testid="query-types-page">{JSON.stringify(query)}</div>,
});
