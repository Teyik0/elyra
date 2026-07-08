import { createRoute } from "../../../src/client";
import { route as rootRoute } from "./root";

const isrRoute = createRoute({
  loader: async () => ({ timestamp: Date.now() }),
  mode: "isr",
  parent: rootRoute,
  revalidate: 60,
});

export default isrRoute.page({
  component: ({ timestamp }) => (
    <div data-testid="isr-page" data-timestamp={String(timestamp)}>
      ISR Page
    </div>
  ),
});
