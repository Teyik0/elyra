import { createRoute, defer } from "../../../src/client";
import { route as rootRoute } from "./root";

const deferRoute = createRoute({
  mode: "ssr",
  parent: rootRoute,
});

export default deferRoute.page({
  component: ({ title }) => <div data-testid="defer-page">{String(title)}</div>,
  loader: async () =>
    defer({
      stats: Promise.resolve(42),
      title: "deferred page",
    }),
});
