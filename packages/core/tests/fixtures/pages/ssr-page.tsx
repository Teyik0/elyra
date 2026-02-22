import { createRoute } from "../../../src/client";
import { route as rootRoute } from "./root";

const ssrRoute = createRoute({
  parent: rootRoute,
  mode: "ssr",
});

export default ssrRoute.page({
  component: () => <div data-testid="ssr-page">SSR Page</div>,
});
