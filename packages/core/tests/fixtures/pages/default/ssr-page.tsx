import { createRoute } from "../../../../src/client";
import { route as rootRoute } from "./root";

const ssrRoute = createRoute({
  mode: "ssr",
  parent: rootRoute,
});

export default ssrRoute.page({
  component: () => <div data-testid="ssr-page">SSR Page</div>,
});
