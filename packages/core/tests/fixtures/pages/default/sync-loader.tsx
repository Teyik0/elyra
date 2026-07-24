import { createRoute } from "../../../../src/client";
import { route as rootRoute } from "./root";

const syncLoaderRoute = createRoute({
  mode: "ssr",
  parent: rootRoute,
});

export default syncLoaderRoute.page({
  component: () => <div>sync loader</div>,
  loader: () => {
    const startedAt = performance.now();
    while (performance.now() - startedAt < 8) {
      // Deliberate synchronous work verifies that DevTools times loader invocation.
    }
    return { completed: true };
  },
});
