import { createRoute } from "../../../../src/client";
import { route as rootRoute } from "../root";

// Static sibling of `dynamic/[id]` — exercises route-specificity matching:
// `/dynamic/specific` must win over `/dynamic/:id` for this exact path.
const specificRoute = createRoute({ parent: rootRoute, mode: "ssr" });

export default specificRoute.page({
  loader: () => ({ pageData: "from-static-specific" }),
  component: ({ pageData }) => <div data-testid="static-specific">{String(pageData)}</div>,
});
