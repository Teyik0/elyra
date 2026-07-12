import { createRoute } from "../../../../../src/client";
import { route as rootRoute } from "../root";

// Static sibling of `dynamic/[id]` — exercises route-specificity matching:
// `/dynamic/specific` must win over `/dynamic/:id` for this exact path.
const specificRoute = createRoute({ mode: "ssr", parent: rootRoute });

export default specificRoute.page({
  component: ({ pageData }) => <div data-testid="static-specific">{String(pageData)}</div>,
  loader: () => ({ pageData: "from-static-specific" }),
});
