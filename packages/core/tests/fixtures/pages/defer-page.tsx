import { createRoute, defer } from "../../../src/client";
import { route as rootRoute } from "./root";

const deferRoute = createRoute({
  parent: rootRoute,
  mode: "ssr",
});

export default deferRoute.page({
  loader: async () =>
    defer({
      title: "deferred page",
      stats: Promise.resolve(42),
    }),
  component: ({ title }) => <div data-testid="defer-page">{String(title)}</div>,
});
